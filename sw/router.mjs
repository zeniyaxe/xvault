// Message router for the service worker (XVault 20). Feature services register the message types
// they own together with the sender capabilities allowed to call them, replacing ad-hoc checks in
// the big onMessage switch. Since XVault 21 every message type is a route; unknown types are rejected.
// Handlers receive (message, sender, capability).
export const DESKTOP = 'desktop';
export const CONTENT = 'content';

export function createMessageRouter() {
  const routes = new Map();
  function register(
    type,
    handler,
    { allow = [DESKTOP], denied = 'This action is only available from XVault pages' } = {}
  ) {
    if (routes.has(type)) throw Error(`Duplicate message route: ${type}`);
    routes.set(type, { handler, allow: new Set(allow), denied });
  }
  /** Mount a service exposing { types, handle(message, sender) }. */
  function mount(service, options = {}) {
    for (const type of service.types) register(type, (message, sender) => service.handle(message, sender), options);
  }
  async function dispatch(message, capability, sender) {
    const route = routes.get(message?.type);
    if (!route) return { handled: false };
    if (!route.allow.has(capability)) throw Error(route.denied);
    return { handled: true, value: await route.handler(message, sender, capability) };
  }
  return {
    register,
    mount,
    dispatch,
    has: type => routes.has(type),
    types: () => [...routes.keys()].sort(),
    policy: type => (routes.has(type) ? [...routes.get(type).allow] : null),
  };
}
