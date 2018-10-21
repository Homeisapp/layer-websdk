/**
 * The Identity class represents an Identity of a user of your application.
 *
 * Identities are created by the System, never directly by apps.
 *
 * @class layer.Identity
 * @extends layer.Syncable
 */

/*
 * How Identities fit into the system:
 *
 * 1. As part of initialization, load the authenticated user's full Identity record so that the Client knows more than just the `userId` of its user.
 *    client.user = <Identity>
 * 2. Any time we get a Basic Identity via `message.sender` or Conversations, see if we have an Identity for that sender,
 *    and if not create one using the Basic Identity.  There should never be a duplicate Identity.
 * 3. Websocket CHANGE events will update Identity objects, as well as add new Full Identities, and downgrade Full Identities to Basic Identities.
 * 4. The Query API supports querying and paging through Identities
 * 5. The Query API loads Full Identities; these results will update the client._models.identities;
 *    upgrading Basic Identities if they match, and adding new Identities if they don't.
 * 6. DbManager will persist only UserIdentities, and only those that are Full Identities.  Basic Identities will be written
 *    to the Messages and Conversations tables anyways as part of those larger objects.
 * 7. API For explicit follows/unfollows
 */

const Syncable = require('./syncable');
const Root = require('../root');
const { SYNC_STATE } = require('../const');
const LayerError = require('../layer-error');
const { strictEncodeURI } = require('../client-utils');


class Identity extends Syncable {
  constructor(options = {}) {
    // Make sure the ID from handle fromServer parameter is used by the Root.constructor
    if (options.fromServer) {
      options.id = options.fromServer.id || '-';
    } else if (!options.id && options.userId) {
      options.id = Identity.prefixUUID + strictEncodeURI(options.userId);
    } else if (options.id && !options.userId) {
      options.userId = decodeURIComponent(options.id.substring(Identity.prefixUUID.length));
    }

    // Make sure we have an clientId property
    if (options.client) options.clientId = options.client.appId;
    if (!options.clientId) throw new Error(LayerError.dictionary.clientMissing);

    super(options);

    if (!this.metadata) this.metadata = {};

    // The - is here to prevent Root from generating a UUID for an ID.  ID must map to UserID
    // and can't be randomly generated.  This only occurs from Platform API sending with `sender.name` and no identity.
    if (this.id === '-') this.id = '';

    this.isInitializing = true;

    if (!this._presence) {
      this._presence = {
        status: null,
        lastSeenAt: null,
      };
    }

    // If the options contains a full server definition of the object,
    // copy it in with _populateFromServer; this will add the Identity
    // to the Client as well.
    if (options && options.fromServer) {
      this._populateFromServer(options.fromServer);
    }

    if (!this.url && this.id) {
      this.url = `${this.getClient().url}/${this.id.substring(9)}`;
    } else if (!this.url) {
      this.url = '';
    }
    this.getClient()._addIdentity(this);

    this.getClient().on('online', (evt) => {
      if (!evt.isOnline) this._updateValue(['_presence', 'status'], Identity.STATUS.OFFLINE);
    }, this);

    this.isInitializing = false;
  }

  destroy() {
    const client = this.getClient();
    if (client) client._removeIdentity(this);
    super.destroy();
  }

  _triggerAsync(evtName, args) {
    this._clearObject();
    super._triggerAsync(evtName, args);
  }

  trigger(evtName, args) {
    this._clearObject();
    super.trigger(evtName, args);
  }

  /**
   * Populates this instance using server-data.
   *
   * Side effects add this to the Client.
   *
   * @method _populateFromServer
   * @private
   * @param  {Object} identity - Server representation of the identity
   */
  _populateFromServer(identity) {
    const client = this.getClient();

    // Disable events if creating a new Identity
    // We still want property change events for anything that DOES change
    this._disableEvents = (this.syncState === SYNC_STATE.NEW);

    this._setSynced();

    this.userId = identity.user_id || '';

    this._updateValue(['avatarUrl'], identity.avatar_url);
    this._updateValue(['displayName'], identity.display_name);

    const isFullIdentity = 'metadata' in identity;

    // Handle Full Identity vs Basic Identity
    if (isFullIdentity) {
      this.url = identity.url;
      this.type = identity.type;

      this._updateValue(['emailAddress'], identity.email_address);
      this._updateValue(['lastName'], identity.last_name);
      this._updateValue(['firstName'], identity.first_name);
      this._updateValue(['metadata'], identity.metadata || {});
      this._updateValue(['publicKey'], identity.public_key);
      this._updateValue(['phoneNumber'], identity.phone_number);
      this.isFullIdentity = true;
    }

    if (!this.url && this.id) {
      this.url = this.getClient().url + this.id.substring(8);
    }

    this._disableEvents = false;

    // See if we have the Full Identity Object in database
    if (!this.isFullIdentity && client.isAuthenticated) {
      client.dbManager.getObjects('identities', [this.id], (result) => {
        if (result.length) this._populateFromServer(result[0]);
      });
    }
  }

  /**
   * Update the property; trigger a change event, IF the value has changed.
   *
   * @method _updateValue
   * @private
   * @param {string[]} keys - Property name parts
   * @param {Mixed} value - Property value
   */
  _updateValue(keys, value) {
    if (value === null || value === undefined) value = '';
    let pointer = this;
    for (let i = 0; i < keys.length - 1; i++) {
      pointer = pointer[keys[i]];
    }
    const lastKey = keys[keys.length - 1];

    if (pointer[lastKey] !== value) {
      if (!this.isInitializing) {
        if (keys[0] === '_presence') keys = [keys[1]];
        this._triggerAsync('identities:change', {
          property: keys.join('.'),
          oldValue: pointer[lastKey],
          newValue: value,
        });
      }
      pointer[lastKey] = value;
    }
  }

  /**
   * Accepts json-patch operations for modifying recipientStatus.
   *
   * Note that except for a camelcase error in last_seen_at,
   * all properties are set prior to calling this method.
   *
   * @method _handlePatchEvent
   * @private
   * @param  {Object[]} data - Array of operations
   */
  _handlePatchEvent(newValueIn, oldValueIn, paths) {
    const changes = [];
    paths.forEach((path) => {
      let newValue = newValueIn,
        oldValue = oldValueIn;
      if (path === 'presence.last_seen_at') {
        this._presence.lastSeenAt = new Date(newValue.last_seen_at);
        newValue = this._presence.lastSeenAt;
        oldValue = oldValue.lastSeenAt;
        delete this._presence.last_seen_at; // Flaw in layer-patch assumes that subproperties don't get camel cased (correct assumption for `recipient_status` and `metadata`)
      } else if (path === 'presence.status') {
        newValue = this._presence.status;
        oldValue = oldValue.status;

        //We receive a huge number of presence.status change events from the websocket that do not represent
        // an actual change in value. Insure we do not trigger events announcing such a change.
        if (newValue === oldValue) return;
      }
      const property = path
        .replace(/_(.)/g, (match, value) => value.toUpperCase())
        .replace(/^presence\./, '');
      changes.push({ property, oldValue, newValue });
    });

    // Don't trigger changes if the only thing to change was lastSeenAt; lastSeenAt only changes if your online,
    // and if your online, lastSeenAt isn't all that significant.
    // The only time changes to `lastSeenAt` should be triggered as an event is when status changes to offline
    if (changes.length !== 1 || changes[0].property !== 'lastSeenAt') {
      changes.forEach(change => this._triggerAsync('identities:change', change));
    }
  }

  /**
   * Follow this User.
   *
   * Following a user grants access to their Full Identity,
   * as well as websocket events that update the Identity.
   * @method follow
   */
  follow() {
    if (this.isFullIdentity) return;
    this._xhr({
      method: 'PUT',
      url: this.url.replace(/identities/, 'following/users'),
      syncable: {},
    }, (result) => {
      if (result.success) this._load();
    });
    this.syncState = SYNC_STATE.LOADING;
  }

  /**
   * Unfollow this User.
   *
   * Unfollowing the user will reduce your access to only having their Basic Identity,
   * and this Basic Identity will only show up when a relevant Message or Conversation has been loaded.
   *
   * Websocket change notifications for this user will not arrive.
   *
   * @method unfollow
   */
  unfollow() {
    this._xhr({
      url: this.url.replace(/identities/, 'following/users'),
      method: 'DELETE',
      syncable: {},
    });
  }

  /**
   * Set the status of the current user.
   *
   * @method setStatus
   * @param {String} status    One of layer.Identity.STATUS.AVAILABLE, layer.Identity.STATUS.AWAY,
   *        layer.Identity.STATUS.BUSY, layer.Identity.STATUS.OFLINE
   */
  setStatus(status) {
    status = (status || '').toLowerCase();
    if (!Identity.STATUS[status.toUpperCase()]) throw new Error(LayerError.dictionary.valueNotSupported);
    if (this !== this.getClient().user) throw new Error(LayerError.dictionary.permissionDenied);
    if (status === Identity.STATUS.INVISIBLE) status = Identity.STATUS.OFFLINE; // these are equivalent; only one supported by server

    const oldValue = this._presence.status;
    this.getClient().sendSocketRequest({
      method: 'PATCH',
      body: {
        method: 'Presence.update',
        data: [
          { operation: 'set', property: 'status', value: status },
        ],
      },
      sync: {
        depends: [this.id],
        target: this.id,
      },
    }, (result) => {
      if (!result.success && result.data.id !== 'authentication_required') this._updateValue(['_presence', 'status'], oldValue);
    });

    // these are equivalent; only one is useful for understanding your state given that your still connected/online.
    if (status === Identity.STATUS.OFFLINE) status = Identity.STATUS.INVISIBLE;

    this._updateValue(['_presence', 'status'], status);
  }

 /**
  * Update the UserID.
  *
  * This will not only update the User ID, but also the ID,
  * URL, and reregister it with the Client.
  *
  * @method _setUserId
  * @private
  * @param {string} userId
  */
  _setUserId(userId) {
    const client = this.getClient();
    client._removeIdentity(this);
    this.__userId = userId;
    const encoded = strictEncodeURI(userId);
    this.id = Identity.prefixUUID + encoded;
    this.url = `${this.getClient().url}/identities/${encoded}`;
    client._addIdentity(this);
  }

  /**
   * __ Methods are automatically called by property setters.
   *
   * Any attempt to execute `this.userId = 'xxx'` will cause an error to be thrown.
   * These are not intended to be writable properties
   *
   * @private
   * @method __adjustUserId
   * @param {string} value - New appId value
   */
  __adjustUserId(userId) {
    if (this.__userId) {
      throw new Error(LayerError.dictionary.cantChangeUserId);
    }
  }

  /**
   * Handle a Websocket DELETE event received from the server.
   *
   * A DELETE event means we have unfollowed this user; and should downgrade to a Basic Identity.
   *
   * @method _handleWebsocketDelete
   * @protected
   * @param {Object} data - Deletion parameters; typically null in this case.
  */
  // Turn a Full Identity into a Basic Identity and delete the Full Identity from the database
  _handleWebsocketDelete(data) {
    this.getClient().dbManager.deleteObjects('identities', [this]);
    ['firstName', 'lastName', 'emailAddress', 'phoneNumber', 'metadata', 'publicKey', 'isFullIdentity', 'type']
      .forEach(key => delete this[key]);
    this._triggerAsync('identities:unfollow');
  }

  /**
   * Create a new Identity based on a Server description of the user.
   *
   * @method _createFromServer
   * @static
   * @param {Object} identity - Server Identity Object
   * @param {layer.Client} client
   * @returns {layer.Identity}
   */
  static _createFromServer(identity, client) {
    return new Identity({
      client,
      fromServer: identity,
      _fromDB: identity._fromDB,
    });
  }
}

/**
 * Display name for the User or System Identity.
 * @type {string}
 */
Identity.prototype.displayName = '';

/**
 * The Identity matching `layer.Client.user` will have this be true.
 *
 * All other Identities will have this as false.
 * @type {boolean}
 */
Identity.prototype.sessionOwner = false;

/**
 * ID of the Client this Identity is associated with.
 * @type {string}
 */
Identity.prototype.clientId = '';

/**
 * Is this a Full Identity or Basic Identity?
 *
 * Note that Service Identities are always considered to be Basic.
 * @type {boolean}
 */
Identity.prototype.isFullIdentity = false;

/**
 * Unique ID for this User.
 * @type {string}
 */
Identity.prototype.userId = '';

/**
 * Optional URL for the user's icon.
 * @type {string}
 */
Identity.prototype.avatarUrl = '';

/**
 * Optional first name for this user.
 *
 * Full Identities Only.
 *
 * @type {string}
 */
Identity.prototype.firstName = '';

/**
 * Optional last name for this user.
 *
 * Full Identities Only.
 *
 * @type {string}
 */
Identity.prototype.lastName = '';

/**
 * Optional email address for this user.
 *
 * Full Identities Only.
 *
 * @type {string}
 */
Identity.prototype.emailAddress = '';

/**
 * Optional phone number for this user.
 *
 * Full Identities Only.
 *
 * @type {string}
 */
Identity.prototype.phoneNumber = '';

/**
 * Optional metadata for this user.
 *
 * Full Identities Only.
 *
 * @type {Object}
 */
Identity.prototype.metadata = null;

/**
 * Optional public key for encrypting message text for this user.
 *
 * Full Identities Only.
 *
 * @type {string}
 */
Identity.prototype.publicKey = '';

/**
 * @static
 * @type {string} The Identity represents a user.  Value used in the layer.Identity.type field.
 */
Identity.UserType = 'user';

/**
 * @static
 * @type {string} The Identity represents a bot.  Value used in the layer.Identity.type field.
 */
Identity.BotType = 'bot';

/**
 * What type of Identity does this represent?
 *
 * * A bot? Use layer.Identity.BotType
 * * A User? Use layer.Identity.UserType
 * @type {string}
 */
Identity.prototype.type = Identity.UserType;

/**
 * Presence object contains presence information for this user.
 *
 * Properties of the sub-object are:
 *
 * * `status`: has the following possible values:
 * ** `available`: User has set their status to `available`.  This is the default initial state
 * ** `away`: App or User has changed their status to `away`
 * ** `busy`: App or User has changed their status to `busy`
 * ** `offline`: User is not connected or has set their status to `offline`
 * ** `invisible`: When a user has set their status to `offline` they instead see a status of `invisible` so that they know
 *    that they have deliberately set their status to `offline` but are still connected.
 * * `lastSeenAt`: Approximate time that the user was last known to be connected (and not `invisible`)
 *
 * @property {Object} _presence
 * @property {String} _presence.status
 * @property {Date} _presence.lastSeenAt
 * @private
 */
Identity.prototype._presence = null;

/**
 * The user's current status or availability.
 *
 * Value is one of:
 *
 * * `layer.Identity.STATUS.AVAILABLE`: User has set their status to `available`.  This is the default initial state
 * * `layer.Identity.STATUS.AWAY`: App or User has changed their status to `away`
 * * `layer.Identity.STATUS.BUSY`: App or User has changed their status to `busy`
 * * `layer.Identity.STATUS.OFFLINE`: User is not connected or has set their status to `offline`
 * * `layer.Identity.STATUS.INVISIBLE`: When a user has set their status to `offline` they instead see a status of `invisible` so that they know
 *    that they have deliberately set their status to `offline` but are still connected.
 *
 * This property can only be set on the session owner's identity, not on other identities via:
 *
 * ```
 * client.user.setStatus(layer.Identity.STATUS.AVAILABLE);
 * ```
 *
 * @property {String} status
 * @readonly
 */
Object.defineProperty(Identity.prototype, 'status', {
  enumerable: true,
  get: function get() {
    return (this._presence && this._presence.status) || Identity.STATUS.OFFLINE;
  },
});

/**
 * Time that the user was last known to be online.
 *
 * Accurate to within about 15 minutes.  User's who are online, but set their status
 * to `layer.Identity.STATUS.INVISIBLE` will not have their `lastSeenAt` value updated.
 *
 * @property {Date} lastSeenAt
 * @readonly
 */
Object.defineProperty(Identity.prototype, 'lastSeenAt', {
  enumerable: true,
  get: function get() {
    return this._presence && this._presence.lastSeenAt;
  },
});

/**
 * Is this Identity a bot?
 *
 * If the layer.Identity.type field is equal to layer.Identity.BotType then this will return true.
 * @property {boolean} isBot
 */
Object.defineProperty(Identity.prototype, 'isBot', {
  enumerable: true,
  get: function get() {
    return this.type === Identity.BotType;
  },
});

/**
 * Possible values for layer.Identity.status field to be used in `setStatus()`
 *
 * @property {Object} STATUS
 * @property {String} STATUS.AVAILABLE   User has set their status to `available`.  This is the default initial state
 * @property {String} STATUS.AWAY        App or User has changed their status to `away`
 * @property {String} STATUS.BUSY     App or User has changed their status to `busy`
 * @property {String} STATUS.OFFLINE  User is not connected or has set their status to `offline`
 * @property {String} STATUS.INVISIBLE  When a user has set their status to `offline` they instead see a status of `invisible` so that they know
 *    that they have deliberately set their status to `offline` but are still connected.
 * @static
 */
Identity.STATUS = {
  AVAILABLE: 'available',
  AWAY: 'away',
  OFFLINE: 'offline',
  BUSY: 'busy',
  INVISIBLE: 'invisible',
};

Identity.inObjectIgnore = Root.inObjectIgnore;

Identity.bubbleEventParent = 'getClient';

Identity._supportedEvents = [
  'identities:change',
  'identities:loaded',
  'identities:loaded-error',
  'identities:unfollow',
].concat(Syncable._supportedEvents);

Identity.eventPrefix = 'identities';
Identity.prefixUUID = 'layer:///identities/';
Identity.enableOpsIfNew = true;

Root.initClass.apply(Identity, [Identity, 'Identity']);
Syncable.subclasses.push(Identity);

module.exports = Identity;
