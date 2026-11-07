import { defineProviderPlugin } from "cursor-byok:plugin";
import { zcodeProvider } from "./provider.ts";
import { credentialImport, presentCredential, RESOURCE_TYPE } from "./resources.ts";

export default defineProviderPlugin({
  providers: [zcodeProvider],
  resources: [{
    type: RESOURCE_TYPE,
    displayName: { "en-US": "ZCode credentials", "zh-CN": "ZCode \u51ed\u8bc1" },
    import: credentialImport,
    present: presentCredential,
  }],
});
