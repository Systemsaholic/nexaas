declare module "ovh" {
  interface OVHOptions {
    appKey: string;
    appSecret: string;
    consumerKey: string;
    endpoint: string;
  }

  class OVH {
    constructor(options: OVHOptions);
    request(method: string, path: string, callback: (err: Error | null, result: any) => void): void;
    request(method: string, path: string, body: Record<string, unknown>, callback: (err: Error | null, result: any) => void): void;
  }

  export = OVH;
}
