"use strict";

class CommandRegistry {
  constructor() {
    this.commands = new Map();
  }

  register(commandType, handler, validator, schema) {
    this.commands.set(commandType, { handler, validator, schema });
  }

  get(commandType) {
    return this.commands.get(commandType);
  }

  has(commandType) {
    return this.commands.has(commandType);
  }

  list() {
    return Array.from(this.commands.keys());
  }
}

module.exports = { CommandRegistry };
