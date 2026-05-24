const registry = new Map();

function register(name, handler) {
  registry.set(name, handler);
}

function has(name) {
  return registry.has(name);
}

function execute(name, ...args) {
  const handler = registry.get(name);
  if (handler) return handler(...args);
  throw new Error(`Skill not found: ${name}`);
}

function list() {
  return [...registry.keys()];
}

module.exports = { register, has, execute, list };
