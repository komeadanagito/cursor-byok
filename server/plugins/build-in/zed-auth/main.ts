import { defineProviderPlugin } from "cursor-byok:plugin";
import { zedNativeAppOAuth } from "./oauth.ts";
import { zedProvider } from "./provider.ts";
import { credentialImport, presentAccount, refreshAccount, RESOURCE_TYPE } from "./resources.ts";

export default defineProviderPlugin({
  providers: [zedProvider],
  resources: [{
    type: RESOURCE_TYPE,
    displayName: {
      "en-US": "Zed accounts",
      "zh-CN": "Zed 账号",
    },
    add: [zedNativeAppOAuth],
    import: credentialImport,
    present: presentAccount,
    refresh: refreshAccount,
  }],
});
