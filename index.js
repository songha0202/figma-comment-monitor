const https = require("https");
const fs = require("fs");

const CONFIG = {
  figma: {
    token: process.env.FIGMA_TOKEN,
    fileKey: process.env.FIGMA_FILE_KEY,
  },
  slack: {
    enabled: !!process.env.SLACK_WEBHOOK_URL,
    webhookUrl: process.env.SLACK_WEBHOOK_URL || "",
  },
  email: {
    enabled: !!(process.env.SMTP_HOST && process.env.SMTP_USER),
    smtp: {
      host: process.env.SMTP_HOST || "",
      port: parseInt(process.env.SMTP_PORT || "587"),
      user: process.env.SMTP_USER || "",
      pass: process.env.SMTP_PASS || "",
    },
    from: process.env.EMAIL_FROM || "",
    to: process.env.EMAIL_TO || "",
  },
  stateFile: "last_seen_ids.json",
};

function log(level, msg) {
  console.log(`[${level.padEnd(10)}] ${msg}`);
}

function httpRequest(url, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = https.request(
      {
        hostname: parsed.hostname,
        port: 443,
        path: parsed.pathname + parsed.search,
        method: options.method || "GET",
        headers: options.headers || {},
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode, body: data }); }
        });
      }
    );
    req.on("error", reject);
    if (body) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}

function loadLastSeenIds() {
  try {
    if (fs.existsSync(CONFIG.stateFile)) {
      const data = JSON.parse(fs.readFileSync(CONFIG.stateFile, "utf8"));
      return new Set(data.ids || []);
    }
  } catch {}
  return new Set();
}

function saveLastSeenIds(ids) {
  fs.writeFileSync(CONFIG.stateFile, JSON.stringify({ ids: [...ids], updatedAt: new Date().toISOString() }));
}

async function fetchComments() {
  const res = await httpRequest(
    `https://api.figma.com/v1/files/${CONFIG.figma.fileKey}/comments`,
    { headers: { "X-Figma-Token": CONFIG.figma.token } }
  );
  if (res.status !== 200)
    throw new Error(`Figma API 오류 ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body.comments || [];
}

async function fetchFileInfo() {
  const res = await httpRequest(
    `https://api.figma.com/v1/files/${CONFIG.figma.fileKey}`,
    { headers: { "X-Figma-Token": CONFIG.figma.token } }
  );
  return res.status === 200 ? res.body : null;
}

async function fetchNodeInfo(nodeId) {
  if (!nodeId) return null;
  const res = await httpRequest(
    `https://api.figma.com/v1/files/${CONFIG.figma.fileKey}/nodes?ids=${encodeURIComponent(nodeId)}`,
    { headers: { "X-Figma-Token": CONFIG.figma.token } }
  );
  if (res.status !== 200) return null;
  const nodes = res.body.nodes || {};
  return nodes[nodeId] || Object.values(nodes)[0] || null;
}

function extractTexts(node, result = []) {
  if (!node) return result;
  if (node.type === "TEXT" && node.characters) result.push(node.characters.trim());
  if (node.children) node.children.forEach((c) => extractTexts(c, result));
  return result;
}

function extractLayerNames(node, result = [], depth = 0) {
  if (!node || depth > 2) return result;
  if (node.name && node.type !== "DOCUMENT") result.push(node.name);
  if (node.children) node.children.slice(0, 10).forEach((c) => extractLayerNames(c, result, depth + 1));
  return result;
}

function analyze(comment, nodeData) {
  const text = (comment.message || "").toLowerCase();

  let category = "💬 피드백";
  if (/bug|오류|깨짐|error|fix|수정|안됨/.test(text)) category = "🐛 버그";
  else if (/글자|텍스트|text|copy|문구|내용|오타/.test(text)) category = "📝 콘텐츠";
  else if (/색|컬러|color|폰트|font|크기|size|간격|spacing|레이아웃|layout|디자인/.test(text)) category = "🎨 디자인";
  else if (/추가|기능|feature|개선|요청/.test(text)) category = "✨ 기능요청";

  let priority = "낮음";
  if (/급함|긴급|urgent|critical|blocking|바로|즉시/.test(text)) priority = "높음";
  else if (/오류|bug|error|깨짐|안됨|수정/.test(text)) priority = "중간";

  let frameSummary = null;
  if (nodeData?.document) {
    const doc = nodeData.document;
    frameSummary = {
      name: doc.name,
      type: doc.type,
      size: doc.absoluteBoundingBox
        ? `${Math.round(doc.absoluteBoundingBox.width)}x${Math.round(doc.absoluteBoundingBox.height)}px`
        : null,
      texts: extractTexts(doc).slice(0, 5),
      layers: extractLayerNames(doc).slice(0, 8),
    };
  }
  return { category, priority, frameSummary };
}

async function enrichComments(comments) {
  const results = [];
  for (const comment of comments) {
    const nodeId = comment.client_meta?.node_id || null;
    let nodeData = null;
    if (nodeId) {
      try {
        nodeData = await fetchNodeInfo(nodeId);
        if (nodeData) log("FRAME", `"${nodeData.document?.name}" (${nodeData.document?.type})`);
      } catch (e) {
        log("WARN", `프레임 조회 실패: ${e.message}`);
      }
    }
    const analysis = analyze(comment, nodeData);
    log("ANALYZE", `[${analysis.category}/${analysis.priority}] ${comment.message.slice(0, 60)}`);
    results.push({ comment, nodeData, analysis });
  }
  return results;
}

const PRIORITY_EMOJI = { "높음": "🔴", "중간": "🟡", "낮음": "🟢" };

async function sendSlack(enriched, fileInfo) {
  if (!CONFIG.slack.enabled || !enriched.length) return;
  const fileName = fileInfo?.name || CONFIG.figma.fileKey;
  const fileUrl = `https://www.figma.com/file/${CONFIG.figma.fileKey}`;
  const blocks = [
    { type: "header", text: { type: "plain_text", text: `🎨 Figma 새 코멘트 ${enriched.length}개 — ${fileName}` } },
    { type: "divider" },
  ];
  for (const { comment, analysis } of enriched.slice(0, 5)) {
    const nodeId = comment.client_meta?.node_id;
    const nodeUrl = nodeId
      ? `https://www.figma.com/file/${CONFIG.figma.fileKey}?node-id=${encodeURIComponent(nodeId)}`
      : fileUrl;
    const lines = [
      `${PRIORITY_EMOJI[analysis.priority] || "⚪"} *[${analysis.category} / ${analysis.priority}]* — *${comment.user?.handle || "알 수 없음"}*`,
      `> ${comment.message}`,
    ];
    if (analysis.frameSummary) {
      const f = analysis.frameSummary;
      lines.push(`📐 *프레임:* ${f.name} (${f.type})${f.size ? ` — ${f.size}` : ""}`);
      if (f.texts.length) lines.push(`📝 *텍스트:* ${f.texts.slice(0, 3).join(" / ")}`);
      if (f.layers.length) lines.push(`🗂 *레이어:* ${f.layers.slice(0, 5).join(", ")}`);
    }
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: lines.join("\n") },
      accessory: { type: "button", text: { type: "plain_text", text: "Figma에서 보기" }, url: nodeUrl },
    });
    blocks.push({ type: "divider" });
  }
  if (enriched.length > 5) {
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: `외 ${enriched.length - 5}개. <${fileUrl}|전체 보기>` }] });
  }
  try {
    await httpRequest(CONFIG.slack.webhookUrl, { method: "POST", headers: { "Content-Type": "application/json" } }, { blocks });
    log("SLACK", `전송 완료 (${enriched.length}개)`);
  } catch (e) { log("SLACK ERROR", e.message); }
}

async function sendEmail(enriched, fileInfo) {
  if (!CONFIG.email.enabled || !enriched.length) return;
  try {
    const nodemailer = require("nodemailer");
    const fileName = fileInfo?.name || CONFIG.figma.fileKey;
    const fileUrl = `https://www.figma.com/file/${CONFIG.figma.fileKey}`;
    const PRIORITY_COLOR = { "높음": "#E24B4A", "중간": "#EF9F27", "낮음": "#1D9E75" };
    const rows = enriched.map(({ comment, analysis }) => {
      const nodeId = comment.client_meta?.node_id;
      const nodeUrl = nodeId ? `https://www.figma.com/file/${CONFIG.figma.fileKey}?node-id=${encodeURIComponent(nodeId)}` : fileUrl;
      const f = analysis.frameSummary;
      return `<tr><td style="padding:16px;border-bottom:1px solid #eee;font-family:sans-serif;font-size:14px;">
        <div style="margin-bottom:8px;">
          <span style="background:${PRIORITY_COLOR[analysis.priority]||"#888"};color:#fff;font-size:11px;padding:2px 8px;border-radius:4px;margin-right:6px;">${analysis.priority} 우선순위</span>
          <span style="background:#f0f0f0;color:#444;font-size:11px;padding:2px 8px;border-radius:4px;">${analysis.category}</span>
        </div>
        <p style="color:#222;font-weight:500;margin:0 0 8px;">"${comment.message}"</p>
        <p style="color:#888;font-size:12px;margin:0 0 8px;">by ${comment.user?.handle || "알 수 없음"}</p>
        ${f ? `<p style="color:#555;font-size:12px;margin:0 0 4px;">📐 <b>프레임:</b> ${f.name} (${f.type})${f.size ? ` — ${f.size}` : ""}${nodeId ? ` — <a href="${nodeUrl}">Figma에서 보기</a>` : ""}</p>` : ""}
        ${f?.texts.length ? `<p style="color:#555;font-size:12px;margin:0 0 4px;">📝 <b>텍스트:</b> ${f.texts.slice(0,3).join(" / ")}</p>` : ""}
        ${f?.layers.length ? `<p style="color:#555;font-size:12px;margin:0;">🗂 <b>레이어:</b> ${f.layers.slice(0,5).join(", ")}</p>` : ""}
      </td></tr>`;
    }).join("");
    const transporter = nodemailer.createTransporter({
      host: CONFIG.email.smtp.host, port: CONFIG.email.smtp.port,
      secure: CONFIG.email.smtp.port === 465,
      auth: { user: CONFIG.email.smtp.user, pass: CONFIG.email.smtp.pass },
    });
    await transporter.sendMail({
      from: CONFIG.email.from, to: CONFIG.email.to,
      subject: `[Figma] 새 코멘트 ${enriched.length}개 — ${fileName}`,
      html: `<div style="max-width:680px;margin:0 auto;"><h2 style="border-bottom:2px solid #0D99FF;padding-bottom:8px;">🎨 Figma 코멘트 알림</h2><p>파일: <a href="${fileUrl}">${fileName}</a> · ${new Date().toLocaleString("ko-KR")}</p><table style="width:100%;border-collapse:collapse;">${rows}</table><p style="text-align:center;margin-top:24px;"><a href="${fileUrl}" style="background:#0D99FF;color:#fff;padding:12px 28px;border-radius:6px;text-decoration:none;">Figma에서 전체 보기</a></p></div>`,
    });
    log("EMAIL", `전송 완료 → ${CONFIG.email.to}`);
  } catch (e) {
    if (e.code === "MODULE_NOT_FOUND") log("EMAIL ERROR", "nodemailer 미설치.");
    else log("EMAIL ERROR", e.message);
  }
}

async function main() {
  log("START", "Figma 코멘트 확인 시작");
  if (!CONFIG.figma.token || !CONFIG.figma.fileKey) {
    log("ERROR", "FIGMA_TOKEN 또는 FIGMA_FILE_KEY 환경변수가 없습니다.");
    process.exit(1);
  }
  const lastSeenIds = loadLastSeenIds();
  log("STATE", `이전에 본 코멘트: ${lastSeenIds.size}개`);
  const [comments, fileInfo] = await Promise.all([fetchComments(), fetchFileInfo()]);
  log("FETCH", `현재 코멘트: ${comments.length}개`);
  const currentIds = new Set(comments.map((c) => c.id));
  if (lastSeenIds.size === 0) {
    log("INIT", "첫 실행: 현재 상태 저장 (다음 실행부터 신규 코멘트 알림)");
    saveLastSeenIds(currentIds);
    return;
  }
  const newComments = comments.filter((c) => !lastSeenIds.has(c.id));
  if (newComments.length === 0) {
    log("POLL", "신규 코멘트 없음");
  } else {
    log("NEW", `신규 코멘트 ${newComments.length}개 발견! 분석 시작...`);
    const enriched = await enrichComments(newComments);
    await Promise.all([sendSlack(enriched, fileInfo), sendEmail(enriched, fileInfo)]);
  }
  saveLastSeenIds(currentIds);
  log("DONE", "완료");
}

main().catch((e) => { log("FATAL", e.message); process.exit(1); });
