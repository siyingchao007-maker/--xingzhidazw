"use strict";
const {setIcon, Notice} = require("obsidian");
// Presentation only: these routes call the existing Views, never send a model request.
const PAGES = Object.freeze([
  {id:"home",label:"首页",en:"HOME",icon:"house"},
  {id:"chat",label:"对话",en:"CHAT",icon:"message-circle"},
  {id:"perceive",label:"观境",en:"PERCEIVE",icon:"mountain",group:"PATH"},
  {id:"anchor",label:"立心",en:"ANCHOR",icon:"target"},
  {id:"test",label:"践真",en:"TEST",icon:"footprints"},
  {id:"hone",label:"知变",en:"HONE",icon:"refresh-cw"},
  {id:"archive",label:"藏知",en:"ARCHIVE",icon:"library",group:"工具"},
  {id:"tune",label:"调律",en:"TUNE",icon:"sliders-horizontal"},
]);
const PANEL_ICONS = Object.freeze({
  "今日命题":"notebook-pen","行知之法":"route","当前链路":"lightbulb",
  "判断修订":"file-pen-line","待验之事":"circle-check","今日洞见":"lightbulb",
  "定所守":"bookmark","待确认的价值信号":"activity","明所欲":"target",
  "知所重":"scale","言行之间":"pen-line","局面":"file-text","我的位置":"map-pin",
  "已知的信息":"database","已有判断与依据":"lightbulb","还不知道的":"circle-help",
  "下一步思考方向":"compass","问得清不清":"files","现实的回答":"notebook-text",
  "还没拿去验的判断":"lightbulb","待辨明的差异":"lightbulb","逐变与固守":"split",
  "近期知变":"clipboard-check","守所不变":"bookmark","回到观境":"refresh-cw",
  "入藏之路":"archive","知识条目":"notebook-pen","它连着什么":"network",
  "这一条":"contact","待入藏":"inbox","定音":"cpu","和弦":"brain",
  "音色":"palette","节拍":"timer","校音":"sliders-horizontal",
});
async function openPage(owner, id) {
  if (!PAGES.some(p=>p.id===id)) throw new Error("未知页面");
  return owner.navigate(id);
}
function buildChatNavigation(parent, owner) {
  const nav=parent.createEl("nav",{cls:"xz-reference-nav",attr:{"aria-label":"行知页面导航"}});
  for(const page of PAGES) {
    if(page.group)nav.createEl("div",{cls:"xz-reference-nav-group",text:page.group});
    const b=nav.createEl("button",{cls:"xz-reference-nav-item",attr:{type:"button","data-ui-page":page.id,"aria-label":page.label,...(page.id==="chat"?{"aria-current":"page"}:{})}});
    const icon=b.createSpan({cls:"xz-reference-nav-icon",attr:{"aria-hidden":"true"}});setIcon(icon,page.icon);
    const copy=b.createSpan({cls:"xz-reference-nav-copy",text:page.label});copy.createEl("small",{text:page.en});
    b.addEventListener("click",()=>{void openPage(owner,page.id).catch(e=>new Notice(e?.message||"未能打开页面"));});
  }
  return nav;
}
function applyChatArt(owner) {
  const dir=String(owner.plugin.manifest?.dir || ".obsidian/plugins/xingzhi-workbench").replace(/\\/gu,"/").replace(/\/$/u,"");
  const preferences=owner.unifiedWorkspace?.cognitive?.preferences || owner.cognitivePreferences || {};
  const skin=preferences.skin === "ink" ? "ink" : "gold";
  owner.contentEl.dataset.referenceSkin=skin;
  owner.contentEl.toggleClass("has-reference-art",preferences.landscape !== false);
  owner.contentEl.toggleClass("is-reference-nav-compact",preferences.compactSidebar === true);
  try {
    const asset=owner.app.vault.adapter.getResourcePath(`${dir}/${skin === "ink" ? "xz-ink-hero-main.png" : "xz-gold-hero-1.png"}`);
    owner.contentEl.style.setProperty("--xz-reference-landscape",`url(${JSON.stringify(asset)})`);
    const side=owner.app.vault.adapter.getResourcePath(`${dir}/xz-${skin}-side-river.png`);
    owner.contentEl.style.setProperty("--xz-reference-side",`url(${JSON.stringify(side)})`);
  } catch { /* Local missing assets have a quiet solid-background fallback. */ }
}
function observeChatWidth(owner) {
  owner.chatWidthObserver?.disconnect();
  owner.chatWidthObserver = null;
  const Observer = owner.containerEl?.ownerDocument?.defaultView?.ResizeObserver || globalThis.ResizeObserver;
  if (typeof Observer !== "function") return;
  // Hidden tabs initialize at width zero. Reconcile when revealed, without
  // rebuilding messages or moving the user's reading position.
  owner.chatWidthObserver = new Observer(() => {
    if (owner.refs.root) owner.syncResponsiveState();
  });
  owner.chatWidthObserver.observe(owner.containerEl);
}
module.exports={PAGES,PANEL_ICONS,openPage,buildChatNavigation,applyChatArt,observeChatWidth};
