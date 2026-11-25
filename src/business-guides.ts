import { readFileSync } from "node:fs";
import type { GuideWorkspace } from "./adp-client.js";

const guides = {
  zh: readFileSync(new URL("../catalog/guide.zh-CN.md", import.meta.url), "utf8"),
  en: readFileSync(new URL("../catalog/guide.en-US.md", import.meta.url), "utf8")
};

const chineseCreditGuidance: Record<GuideWorkspace, string> = {
  cn: "中国区公有云用户可[登录中国大陆 ADP 工作台](https://adp.laiye.com/)查看余额，在账户管理中查看积分流水、历史订单并自助充值。私有部署请使用本部署的账户入口或联系管理员。",
  global: "全球区公有云用户可[登录全球区 ADP 工作台](https://adp-global.laiye.com/)查看余额和账单，需要补充积分时联系来也工作人员。私有部署请使用本部署的账户入口或联系管理员。",
  private: "请使用本部署的账户入口查看额度，或联系本部署管理员补充额度。",
  unknown: "请先确认当前账号所属的区域或部署，再到对应工作台查看余额和账单。"
};

const englishCreditGuidance: Record<GuideWorkspace, string> = {
  cn: "In the [China cloud workspace](https://adp.laiye.com/), check the balance in your profile and use Account Management to review transactions and orders or top up credits. For a private deployment, use its account portal or contact its administrator.",
  global: "In the [Global cloud workspace](https://adp-global.laiye.com/), check your balance and billing history. Contact your Laiye representative to add credits. For a private deployment, use its account portal or contact its administrator.",
  private: "Check your allowance in the account area of your deployment or contact its administrator.",
  unknown: "Confirm your account's region or deployment, then check your balance and bills in its workspace."
};

export function businessGuide(language: string, workspace: GuideWorkspace, allowChinaInvoice: boolean): string {
  const guide = language.toLowerCase().startsWith("en")
    ? guides.en.replace("{credit_action}", englishCreditGuidance[workspace])
    : guides.zh.replace("{credit_action}", chineseCreditGuidance[workspace]);
  return allowChinaInvoice
    ? guide.replaceAll(" <!-- china-invoice -->", "")
    : guide.replace(/^.* <!-- china-invoice -->\r?\n/gm, "");
}
