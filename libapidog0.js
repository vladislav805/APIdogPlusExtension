/**
 * APIdog Plus extension
 * @version 3.1
 * @author Vladislav Veluga; velu.ga
 */

// https://stackoverflow.com/a/55215898/6142038
function fetchResource(input, init) {
	// В Firefox такой костыль не работает, поэтому не делаем через жопу, а делаем прямо
	if (navigator.userAgent.indexOf('Firefox') >= 0) {
		return fetch(input, init);
	}

	return new Promise((resolve, reject) => {
		chrome.runtime.sendMessage({input, init}, messageResponse => {
			const [response, error] = messageResponse;

			if (response === null) {
				reject(error);
			} else {
				// Use undefined on a 204 - No Content
				const body = response.body ? new Blob([response.body]) : undefined;
				resolve(new Response(body, {
					status: response.status,
					statusText: response.statusText,
				}));
			}
		});
	});
}

/**
 * Запрос к API ВКонтакте
 * @param {string} method Название метода API
 * @param {object} params Объект параметров
 * @param {function} callback Callback-функция
 */
function apiRequest(method, params, callback) {
	const queryString = [];

	for (const key in params) {
		if (params.hasOwnProperty(key)) {
			queryString.push(encodeURIComponent(key) + '=' + encodeURIComponent(params[key]));
		}
	}

	fetchResource('https://api.vk.com/method/' + method, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded',
		},
		body: queryString.join('&'),
	}).then(res => res.json()).then(json => callback(json));
}

const EXTENSION_VERSION = 3.3;
const EXTENSION_AGENT = 'all';

const METHOD_ACCESS_TOKEN_REQUIRE = 'onAccessTokenRequire';
const METHOD_LONGPOLL_DATA_RECEIVED = 'onLongPollDataReceived';
const METHOD_LONGPOLL_CONNECTION_ERROR = 'onLongPollConnectionError';

const EVENT_ACCESS_TOKEN_RECEIVED = 'onAccessTokenReceived';

const ERROR_NO_RESPONSE_VKAPI = 1;
const ERROR_WHILE_REQUEST_LONGPOLL = 2;

/**
 * Отправляет событие из расширения на страницу
 * @param {string} method
 * @param {object} data
 * @param {string=} callback
 */
function sendEvent(method, data, callback) {
	data.method = method;
	data.callback = callback;
	data.version = EXTENSION_VERSION;
	data.agent = EXTENSION_AGENT;
	console.log('sendEvent:', method + '@' + JSON.stringify(data));
	window.postMessage(JSON.stringify(data), '*');
}

/**
 * Функция-распределитель событий, приходящих с сайта
 * @param {string} method
 * @param {object} data
 */
function receiveEvent(method, data) {
	switch (method) {

		// Получение токена от страницы
		case EVENT_ACCESS_TOKEN_RECEIVED:
			LongPoll.userAgent = data.userAgent;
			data.apiVersion && (LongPoll.apiVersion = data.apiVersion);
			data.mode && (LongPoll.mode = data.mode);
			data.longpollVersion && (LongPoll.longpollVersion = data.longpollVersion);
			LongPoll.init(data.useraccesstoken);
			break;
	}
}

/**
 * Обработчик событий со страницы
 */
window.addEventListener('message', event => {
	if (event.source !== window) {
		return;
	}

	try {
		const data = event.data;
		// дитчайший костыль
		const isJSON = typeof data === 'string' && data[0] === '{' && data[data.length - 1] === '}';
		const res = isJSON ? JSON.parse(event.data) : event.data;

		if (res && res.method && !res.agent) {
			receiveEvent(res.method, res);
		}
	} catch (e) {
		console.error('onMessage:', event.data, e);
	}
});





const LongPoll = {

	/**
	 * @var {string}
	 * @public
	 * @static
	 */
	userAgent: 'VKAndroidApp/4.12-1118',

	/**
	 * @var {number}
	 * @public
	 * @static
	 */
	apiVersion: 5.119,

	/**
	 * @var {number}
	 * @public
	 * @static
	 */
	longpollVersion: 3,

	/**
	 * @var {number}
	 * @public
	 * @static
	 */
	mode: 2 | 8 | 64 | 128,

	/**
	 * @var {string|null}
	 * @private
	 */
	__userAccessToken: null,

	/**
	 * @var {{}|null}
	 * @private
	 */
	__params: null,

	/**
	 * @var {boolean}
	 * @private
	 */
	__stopped: true,

	/**
	 * @var {XMLHttpRequest|null}
	 * @private
	 */
	__xhr: null,

	/**
	 * Инициализация LongPoll
	 * @public
	 */
	init: function(userAccessToken) {
		console.info('[Extension] start init longpoll');

		if (!this.__stopped) {
			console.log('[Extension] already running');
			return;
		}

		this.__stopped = false;
		this.__userAccessToken = userAccessToken;
		this.__getServer();
	},

	/**
	 * Получение адреса сервера LongPoll
	 * @private
	 */
	__getServer: function() {
		if (this.__stopped) {
			return;
		}

		apiRequest('messages.getLongPollServer', {
			access_token: this.__userAccessToken,
			lp_version: LongPoll.longpollVersion,
			v: LongPoll.apiVersion,
		}, data => {
			if (!data.response) {
				data = data.error;
				sendEvent(METHOD_LONGPOLL_DATA_RECEIVED, {
					errorId: ERROR_NO_RESPONSE_VKAPI,
					error: data
				});
				return;
			}

			this.__params = data.response;
			this.__request();
		});
	},

	/**
	 * Запрос к LongPoll для получения новых событий
	 * @private
	 */
	__request: function() {
		fetchResource('https://' + this.__params.server + '?act=a_check&key=' + this.__params.key + '&ts=' + this.__params.ts + '&wait=25&mode=' + LongPoll.mode + '&version=' + LongPoll.longpollVersion)
			.then(res => res.json())
			.then(result => {
				if (result.failed) {
					return this.__getServer();
				}

				this.__params.ts = result.ts;
				this.__xhr = null;
				this.__request();
				this.__sendEvents(result.updates);
			}).catch(event => {
				sendEvent(METHOD_LONGPOLL_CONNECTION_ERROR, {
					errorId: ERROR_WHILE_REQUEST_LONGPOLL,
					error: event
				});
				this.__getServer();
			});
	},

	/**
	 * Отправка событий на сайт
	 * @param {object[]} items
	 * @private
	 */
	__sendEvents: items => sendEvent(METHOD_LONGPOLL_DATA_RECEIVED, { updates: items }),

	/**
	 * Разрыв соединения
	 * @public
	 */
	abort: function() {
		this.__stopped = true;
		if (this.__xhr) {
			this.__xhr.abort();
		}
	},
};

/**
 * Инициализация расширения на странице: запрос токена с сайта
 */
sendEvent(METHOD_ACCESS_TOKEN_REQUIRE, {}, EVENT_ACCESS_TOKEN_RECEIVED);

/**
 * Костыль для Firefox
 * Не сбрасываются скрипты при перезагрузке одной вкладки
 * В chrome же выгрузка скриптов происходит при перезагрузке или
 * закрытии вкладки. Firefox выгружает скрипты только при закрытии
 * вкладки
 */
window.addEventListener('beforeunload', function() {
	LongPoll.abort();
});
