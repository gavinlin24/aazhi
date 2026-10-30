// Only what the page script tests use. The full Node typings would put Node's
// globals into the type check of the Worker code too, which runs without them.
declare module "node:vm" {
  export class Script {
    constructor(code: string, options?: { filename?: string });
  }
  export function runInNewContext(code: string, context?: object): unknown;
}
