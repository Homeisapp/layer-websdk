/**
 * @class  layer.Websockets.RequestManager
 * @private
 *
 * This class allows one to send requests to the websocket server, and provide a callback,
 * And have that callback either called by the correct websocket server response, or
 * be called with a timeout.
 */
const Utils = require('../client-utils');
const logger = require('../logger');
const LayerError = require('../layer-error');

// Wait 45 seconds for a response and then give up
const DELAY_UNTIL_TIMEOUT = 45 * 1000;

class WebsocketRequestManager {
  /**
   * Create a new websocket change manager
   *
   *      var websocketRequestManager = new layer.Websockets.RequestManager({
   *          client: client,
   *          socketManager: client.Websockets.SocketManager
   *      });
   *
   * @method
   * @param  {Object} options
   * @param {layer.Client} client
   * @param {layer.Websockets.SocketManager} socketManager
   * @returns {layer.Websockets.RequestManager}
   */
  constructor(options) {
    this.client = options.client;
    this.socketManager = options.socketManager;
    this.socketManager.on({
      message: this._handleResponse,
      disconnected: this._reset,
    }, this);

    this._requestCallbacks = {};
  }

  _reset() {
    this._requestCallbacks = {};
  }

  /**
   * This is an imprecise method; it will cancel ALL requests of a given type.
   *
   * @method cancelOperation
   * @param {String} methodName    `Message.create`, `Event.sync`, etc...
   */
  cancelOperation(methodName) {
    Object.keys(this._requestCallbacks).forEach((key) => {
      const requestConfig = this._requestCallbacks[key];
      if (requestConfig.method === methodName) delete this._requestCallbacks[key];
    });
  }

  /**
   * Handle a response to a request.
   *
   * @method _handleResponse
   * @private
   * @param  {layer.LayerEvent} evt
   */
  _handleResponse(evt) {
    if (evt.data.type === 'response') {
      const msg = evt.data.body;
      const requestId = msg.request_id;
      logger.debug(`Websocket response ${requestId} ${msg.success ? 'Successful' : 'Failed'}`);

      if (requestId && this._requestCallbacks[requestId]) {
        this._processResponse(requestId, evt);
      }
    }
  }

  /**
   * Process a response to a request; used by _handleResponse.
   *
   * Refactored out of _handleResponse so that unit tests can easily
   * use it to trigger completion of a request.
   *
   * @method _processResponse
   * @private
   * @param {String} requestId
   * @param {Object} evt   Data from the server
   */
  _processResponse(requestId, evt) {
    const request = this._requestCallbacks[requestId];
    const msg = evt.data.body;
    const data = (msg.success ? msg.data : new LayerError(msg.data)) || {};

    if (msg.success) {
      if (request.isChangesArray) {
        this._handleChangesArray(data.changes);
      }
      if ('batch' in data) {
        request.batchTotal = data.batch.count;
        request.batchIndex = data.batch.index;
        if (request.isChangesArray) {
          request.results = request.results.concat(data.changes);
        } else if ('results' in data && Array.isArray(data.results)) {
          request.results = request.results.concat(data.results);
        }
        if (data.batch.index < data.batch.count - 1) return;
      }
    }
    request.callback({
      success: msg.success,
      fullData: 'batch' in data ? request.results : evt.data,
      data,
    });
    delete this._requestCallbacks[requestId];
  }

  /**
   * Any request that contains an array of changes should deliver each change
   * to the socketChangeManager.
   *
   * @method _handleChangesArray
   * @private
   * @param {Object[]} changes   "create", "update", and "delete" requests from server.
   */
  _handleChangesArray(changes) {
    changes.forEach(change => this.client.socketChangeManager._processChange(change));
  }

  /**
   * Shortcut for sending a request; builds in handling for callbacks
   *
   *    manager.sendRequest({
   *      data: {
   *        operation: "delete",
   *        object: {id: "layer:///conversations/uuid"},
   *        data: {deletion_mode: "all_participants"}
   *      },
   *      callback: function(result) {
   *        alert(result.success ? "Yay" : "Boo");
   *      },
   *      isChangesArray: false
   *    });
   *
   * @method sendRequest
   * @param  {Object} options
   * @param  {Object} otions.data                     Data to send to the server
   * @param  {Function} [options.callback=null]       Handler for success/failure callback
   * @param  {Boolean} [options.isChangesArray=false] Response contains a changes array that can be fed directly to change-manager.
   * @returns the request callback object if there is one; primarily for use in testing.
   */
  sendRequest({ data, callback, isChangesArray = false }) {
    if (!this._isOpen()) {
      return !callback ? undefined : callback(new LayerError({
        success: false,
        data: { id: 'not_connected', code: 0, message: 'WebSocket not connected' },
      }));
    }
    const body = Utils.clone(data);
    body.request_id = 'r' + this._nextRequestId++;
    logger.debug(`Request ${body.request_id} is sending`);
    if (callback) {
      this._requestCallbacks[body.request_id] = {
        request_id: body.request_id,
        date: Date.now(),
        callback,
        isChangesArray,
        method: data.method,
        batchIndex: -1,
        batchTotal: -1,
        results: [],
      };
    }

    this.socketManager.send({
      type: 'request',
      body,
    });
    this._scheduleCallbackCleanup();
    if (body.request_id) return this._requestCallbacks[body.request_id];
  }

  /**
   * Flags a request as having failed if no response within 2 minutes
   *
   * @method _scheduleCallbackCleanup
   * @private
   */
  _scheduleCallbackCleanup() {
    if (!this._callbackCleanupId) {
      this._callbackCleanupId = setTimeout(this._runCallbackCleanup.bind(this), DELAY_UNTIL_TIMEOUT + 50);
    }
  }

  /**
   * Calls callback with an error.
   *
   * NOTE: Because we call requests that expect responses serially instead of in parallel,
   * currently there should only ever be a single entry in _requestCallbacks.  This may change in the future.
   *
   * @method _runCallbackCleanup
   * @private
   */
  _runCallbackCleanup() {
    this._callbackCleanupId = 0;
    // If the websocket is closed, ignore all callbacks.  The Sync Manager will reissue these requests as soon as it gets
    // a 'connected' event... they have not failed.  May need to rethink this for cases where third parties are directly
    // calling the websocket manager bypassing the sync manager.
    if (this.isDestroyed || !this._isOpen()) return;
    let count = 0,
      abort = false;
    const now = Date.now();
    Object.keys(this._requestCallbacks).forEach((requestId) => {
      const callbackConfig = this._requestCallbacks[requestId];
      if (abort) return;

      // If the request hasn't expired, we'll need to reschedule callback cleanup; else if its expired...
      if (callbackConfig && now < callbackConfig.date + DELAY_UNTIL_TIMEOUT) {
        count++;
      }

      // If there has been no data from the server, there's probably a problem with the websocket; reconnect.
      else if (now > this.socketManager._lastDataFromServerTimestamp + DELAY_UNTIL_TIMEOUT) {
        // Retrying isn't currently handled here; its handled by the caller (typically sync-manager); so clear out all requests,
        // notifying the callers that they have failed.
        abort = true;
        this._failAll();
        this.socketManager._reconnect(false);
      } else {
        // The request isn't responding and the socket is good; fail the request.
        this._timeoutRequest(requestId);
      }
    });
    if (count) this._scheduleCallbackCleanup();
  }

  /**
   * Any requests that have not had responses are considered as failed if we disconnect without a response.
   *
   * Call all callbacks with a `server_unavailable` error.  The caller may retry,
   * but this component does not have built-in retry.
   *
   * @method
   * @private
   */
  _failAll() {
    Object.keys(this._requestCallbacks).forEach((requestId) => {
      try {
        logger.warn('Websocket request aborted due to reconnect');
        this._requestCallbacks[requestId].callback({
          success: false,
          status: 503,
          data: new LayerError({
            id: 'socket_dead',
            message: 'Websocket appears to be dead. Reconnecting.',
            url: 'https:/developer.layer.com/docs/websdk',
            code: 0,
            status: 503,
            httpStatus: 503,
          }),
        });
      } catch (err) {
        // Do nothing
      }
      delete this._requestCallbacks[requestId];
    });
  }

  _timeoutRequest(requestId) {
    try {
      logger.warn('Websocket request timeout');
      this._requestCallbacks[requestId].callback({
        success: false,
        data: new LayerError({
          id: 'request_timeout',
          message: 'The server is not responding. We know how much that sucks.',
          url: 'https:/developer.layer.com/docs/websdk',
          code: 0,
          status: 408,
          httpStatus: 408,
        }),
      });
    } catch (err) {
      // Do nothing
    }
    delete this._requestCallbacks[requestId];
  }

  _isOpen() {
    return this.socketManager._isOpen();
  }

  destroy() {
    this.isDestroyed = true;
    if (this._callbackCleanupId) clearTimeout(this._callbackCleanupId);
    this._requestCallbacks = null;
  }
}

WebsocketRequestManager.prototype._nextRequestId = 1;

/**
 * The Client that owns this.
 * @type {layer.Client}
 */
WebsocketRequestManager.prototype.client = null;

WebsocketRequestManager.prototype._requestCallbacks = null;

WebsocketRequestManager.prototype._callbackCleanupId = 0;

WebsocketRequestManager.prototype.socketManager = null;

module.exports = WebsocketRequestManager;

