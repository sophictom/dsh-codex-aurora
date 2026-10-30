import { loadBundle, createDocument, createOfficialMenu, createFakeHost, settle } from "./harness.mjs";
import { writeFileSync } from "node:fs";

const document = createDocument();
const menu = createOfficialMenu(document);
const bundle = loadBundle(new URL("../lib/client.js", import.meta.url), document, {});
const host = createFakeHost({});
bundle.plugin.apply(host.ctx);
const entry = host.registered[0];
bundle.react.mount(entry.Component, { sessionId: "session-abcdef" }, menu.composer);
await settle();
const internals = bundle.plugin.__internals;

// 拖到最高档
const trackNode = bundle.react.find("track");
trackNode.rect = { left: 0, top: 0, right: 300, bottom: 24, width: 300, height: 24 };
trackNode.fire("onPointerDown", { clientX: 300 - internals.KNOB_RADIUS, pointerId: 1 });
trackNode.fire("onPointerUp", {});
await settle();

function esc(v){ return String(v).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/"/g,"&quot;"); }
function ser(node){
  if(!node) return "";
  if(node.nodeType===3) return node._text ?? "";
  const tag = node.tagName.toLowerCase();
  const attrs=[];
  for(const [k,v] of node.attributes){ if(k==="key") continue; if(k==="data-ces-part") attrs.push(`data-part="${esc(v)}"`); else attrs.push(`${k}="${esc(v)}"`); }
  const kebab = (k) => k.startsWith("--") ? k : k.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());
  const style = node.style && Object.keys(node.style).length ? Object.entries(node.style).filter(([,v])=>v!==undefined&&v!==null&&v!=="").map(([k,v])=>`${kebab(k)}:${v}`).join(";") : "";
  if(style) attrs.push(`style="${esc(style)}"`);
  const kids = node.children.map(ser).join("");
  return `<${tag}${attrs.length?" "+attrs.join(" "):""}>${kids}</${tag}>`;
}
const root = bundle.react.find("root");
let p = root; const chain=[];
while(p){ chain.push(p.tagName + (p.attributes && p.attributes.get && p.attributes.get("class") ? "."+p.attributes.get("class") : "")); p = p.parentNode; }
console.log("chain:", chain.join(" < "));
const body = ser(root);
writeFileSync(new URL("../preview_dump.html", import.meta.url), `<!doctype html><html><head><meta charset="utf-8"><style>
  body{margin:0;padding:16px;background:#fff;font-family:"Segoe UI",system-ui,sans-serif}
  .wrap{width:300px}
  ${internals.CSS}
</style></head><body><div class="wrap">${body}</div></body></html>`);
console.log("parts:", bundle.react.findAll("particle").length, "fields:", bundle.react.findAll("starfield").length);
console.log("html bytes", body.length);
console.log(body.slice(0,900));
