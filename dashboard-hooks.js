/* Explicit extension points for the dashboard (XVault 19).
   Feature scripts used to reassign dashboard.js function declarations (`page = function …`), which made the
   script load order load-bearing, hid the call chain and let one bad wrapper break every page. They now
   register here instead:
     XVaultDashboard.before(name, fn)    fn(...args) runs before the built-in function
     XVaultDashboard.after(name, fn)     fn(result, ...args) runs after it (after the promise settles for async ones)
     XVaultDashboard.provide(name, make) make(builtin) returns the one replacement implementation
     XVaultDashboard.commands(source)    source(query) adds Command Center entries
   Observer errors are reported and isolated; they never stop the built-in function or other observers. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.XVaultDashboardHooks = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function createHooks(names, { onError = error => console.error('[XVault] dashboard hook failed', error) } = {}) {
    const known = new Set(names),
      before = new Map(),
      after = new Map(),
      factories = new Map(),
      implementations = new Map(),
      commandSources = [];

    function check(name) {
      if (!known.has(name)) throw new Error(`Unknown dashboard hook "${name}"`);
    }
    function add(map, name, fn) {
      check(name);
      if (typeof fn !== 'function') throw new TypeError(`Dashboard hook "${name}" needs a function`);
      const list = map.get(name) || [];
      list.push(fn);
      map.set(name, list);
      return () => {
        const index = list.indexOf(fn);
        if (index >= 0) list.splice(index, 1);
      };
    }
    function notify(list, args) {
      for (const fn of list ? list.slice() : []) {
        try {
          fn(...args);
        } catch (error) {
          onError(error);
        }
      }
    }
    function provide(name, make) {
      check(name);
      if (typeof make !== 'function') throw new TypeError(`Dashboard provider "${name}" needs a function`);
      if (factories.has(name)) throw new Error(`Dashboard function "${name}" already has a provider`);
      factories.set(name, make);
      implementations.delete(name);
    }
    function implementation(name, builtin) {
      if (!factories.has(name)) return builtin;
      if (!implementations.has(name)) {
        const made = factories.get(name)(builtin);
        if (typeof made !== 'function') throw new TypeError(`Dashboard provider "${name}" did not return a function`);
        implementations.set(name, made);
      }
      return implementations.get(name);
    }
    /** Runs the hooked function `name`: before observers, the provider (or built-in), then after observers. */
    function invoke(name, builtin, thisArg, args) {
      check(name);
      notify(before.get(name), args);
      const result = implementation(name, builtin).apply(thisArg, args);
      const observers = after.get(name);
      if (!observers || !observers.length) return result;
      if (result && typeof result.then === 'function')
        return result.then(value => {
          notify(observers, [value, ...args]);
          return value;
        });
      notify(observers, [result, ...args]);
      return result;
    }
    function commands(source) {
      if (typeof source !== 'function') throw new TypeError('Command sources must be functions');
      commandSources.push(source);
      return () => {
        const index = commandSources.indexOf(source);
        if (index >= 0) commandSources.splice(index, 1);
      };
    }
    function extraCommands(query) {
      return commandSources.flatMap(source => {
        try {
          const list = source(query);
          return Array.isArray(list) ? list : [];
        } catch (error) {
          onError(error);
          return [];
        }
      });
    }
    return Object.freeze({
      before: (name, fn) => add(before, name, fn),
      after: (name, fn) => add(after, name, fn),
      provide,
      invoke,
      commands,
      extraCommands,
      provided: name => factories.has(name),
      names: () => [...known],
    });
  }
  return Object.freeze({ createHooks });
});
