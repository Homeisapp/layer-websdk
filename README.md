# Layer Web SDK

[![Build Status](http://img.shields.io/travis/layerhq/layer-websdk.svg)](https://travis-ci.org/layerhq/layer-websdk)
[![npm version](http://img.shields.io/npm/v/layer-websdk.svg)](https://npmjs.org/package/layer-websdk)

The Layer Web SDK is a JavaScript library for adding chat services to your web application. For detailed documentation, tutorials and guides please visit our [Web SDK documentation](https://docs.layer.com/sdk/web-3.0/install).

## Just Starting?

Use our new XDK! The XDK enables a richer messaging experience and new features will be added there. See the repository at [https://github.com/layerhq/web-xdk](https://github.com/layerhq/web-xdk). Don't worry, Layer Web SDK is still supported.

## Supported Browsers

* IE 11 and Edge
* Safari 7
* Chrome 42 and up
* Firefox 40 and up

Older versions of Chrome and Firefox will likely work.

## Installation

All examples below assume your using the CDN installation method; adapting instructions to other methods should be straightforward.

### CDN

Simplest approach to install the Web SDK is to add the following script tag:

```html
<script src='//cdn.layer.com/sdk/3.1.0/layer-websdk.min.js'></script>
```

* For stricter code control, use `//cdn.layer.com/sdk/3.0.n/layer-websdk.min.js` instead. (where `n` is the patch number for the desired release)

All classes can then be accessed via the `layer` namespace:

```javascript
var client = new layer.Client({
    appId: LAYER_APP_ID
});
```

### NPM

    npm install layer-websdk --save

All classes can then be accessed via the layer module:

```javascript
var layer = require('layer-websdk');

var client = new layer.Client({
    appId: LAYER_APP_ID
});
```

#### NPM ES6 Build

```javascript
var layer = require('layer-websdk/index-es6');

var client = new layer.Client({
    appId: LAYER_APP_ID
});
```

#### NPM React Native Build

```javascript
var layer = require('layer-websdk/index-react-native');

var client = new layer.Client({
    appId: LAYER_APP_ID
});
```

### From source

Download the latest SDK release [Source code](https://github.com/layerhq/layer-websdk/releases/latest) archive, extract the files and run the following commands from the extracted project folder:

    > npm install
    > grunt build

A `build/` folder will be generated that contains `client.min.js` file.

Other build commands:

* `grunt debug`: Generates `build/client.debug.js` which provides source-mapped files if you need to step through the Web SDK.
* `grunt docs`: Generates `docs/index.html` which you can open to view the API documentation.
* `grunt test`: Run the unit tests


## Getting Started

* For a full introduction, see https://docs.layer.com/sdk/web/introduction
* For an API Reference, see https://docs.layer.com/api_reference/web-3.0/