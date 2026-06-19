// Renders an attendance bar chart (last N games) to a PNG Buffer — no AI, no storage.
// Lazy-requires @napi-rs/canvas so unit tests / non-chart code don't need the native dep loaded.

const DAY_ABBR_PL = { friday: "pt", thursday: "czw", wednesday: "śr", saturday: "sb", sunday: "nd", monday: "pn", tuesday: "wt" };

// entries: [{date, gameDay, status, players}], optimum: number (dotted line)
function renderFrekwencjaChart(entries, optimum) {
  const { createCanvas } = require("@napi-rs/canvas");
  const data = (entries || []).slice(-10);
  const opt = optimum || 12;

  const W = 900, H = 480;
  const padL = 56, padR = 24, padT = 64, padB = 70;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const maxVal = Math.max(opt + 2, ...data.map(d => d.players || 0), 1);
  const x0 = padL, y0 = padT + plotH;
  const yFor = v => y0 - (v / maxVal) * plotH;

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");

  // background
  ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, W, H);

  // title
  ctx.fillStyle = "#111827"; ctx.font = "bold 26px sans-serif"; ctx.textAlign = "left";
  ctx.fillText("Frekwencja - ostatnie " + data.length + " treningow", padL, 38);

  // y gridlines + labels
  ctx.textAlign = "right"; ctx.font = "13px sans-serif";
  const step = maxVal <= 14 ? 2 : Math.ceil(maxVal / 7);
  for (let v = 0; v <= maxVal; v += step) {
    const y = yFor(v);
    ctx.strokeStyle = "#eceff1"; ctx.setLineDash([]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x0 + plotW, y); ctx.stroke();
    ctx.fillStyle = "#90a4ae"; ctx.fillText(String(v), x0 - 8, y + 4);
  }

  // bars
  const n = Math.max(data.length, 1);
  const slot = plotW / n;
  const bw = Math.min(60, slot * 0.6);
  ctx.textAlign = "center";
  data.forEach((d, i) => {
    const cx = x0 + slot * (i + 0.5);
    const cancelled = d.status === "cancelled";
    const val = d.players || 0;
    const h = (val / maxVal) * plotH;
    if (cancelled) {
      ctx.fillStyle = "#cfd8dc";
      ctx.fillRect(cx - bw / 2, y0 - Math.max(h, 3), bw, Math.max(h, 3));
    } else {
      ctx.fillStyle = val >= opt ? "#2e7d32" : (val >= opt - 3 ? "#f9a825" : "#c62828");
      ctx.fillRect(cx - bw / 2, y0 - h, bw, h);
    }
    // value above bar
    ctx.fillStyle = "#37474f"; ctx.font = "bold 14px sans-serif";
    ctx.fillText(cancelled ? "ODW" : String(val), cx, y0 - (cancelled ? Math.max(h, 3) : h) - 6);
    // x label: day + dd.mm
    ctx.fillStyle = "#607d8b"; ctx.font = "12px sans-serif";
    const dpl = DAY_ABBR_PL[d.gameDay] || "";
    const dm = (d.date || "").slice(5).replace("-", ".");
    ctx.fillText(dpl, cx, y0 + 18);
    ctx.fillText(dm, cx, y0 + 34);
  });

  // optimum dotted line (on top)
  const yOpt = yFor(opt);
  ctx.strokeStyle = "#1565c0"; ctx.setLineDash([8, 5]); ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(x0, yOpt); ctx.lineTo(x0 + plotW, yOpt); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = "#1565c0"; ctx.font = "bold 13px sans-serif"; ctx.textAlign = "left";
  ctx.fillText("optimum " + opt, x0 + 4, yOpt - 6);

  // axis baseline
  ctx.strokeStyle = "#b0bec5"; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x0 + plotW, y0); ctx.stroke();

  return canvas.toBuffer("image/png");
}

module.exports = { renderFrekwencjaChart };
