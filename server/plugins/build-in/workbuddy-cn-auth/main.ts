import { defineProviderPlugin } from "cursor-byok:plugin";
import { workbuddyProvider } from "./provider.ts";
import { credentialImport, presentAccount, refreshAccount, RESOURCE_TYPE } from "./resources.ts";
import { workbuddyDeviceOAuth } from "./oauth.ts";

export default defineProviderPlugin({
  providers: [workbuddyProvider],
  resources: [{
    type: RESOURCE_TYPE,
    displayName: {
      "en-US": "WorkBuddy CN accounts & tokens",
      "zh-CN": "WorkBuddy CN 账号与令牌",
    },
    add: [workbuddyDeviceOAuth],
    import: credentialImport,
    present: presentAccount,
    refresh: refreshAccount,
  }],
});
