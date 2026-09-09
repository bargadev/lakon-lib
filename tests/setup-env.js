'use strict';

// Tests must never spawn a real proxy daemon or edit the developer's shell rc.
// `install()`/`uninstall()` honour this flag; the proxy tests drive the daemon
// module directly, so they are unaffected.
process.env.LAKON_PROXY_DISABLE = '1';
