declare module "@earendil-works/pi-coding-agent" {
  export interface ExtensionAPI {
    on(
      event: string,
      handler: (event: unknown, context: unknown) => void | Promise<void>,
    ): void;
    registerCommand(
      name: string,
      command: {
        description: string;
        handler: (args: string, context: unknown) => void | Promise<void>;
      },
    ): void;
    [key: string]: unknown;
  }
}
