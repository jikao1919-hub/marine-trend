/*
 * Marine Trend デモ
 * Scopus Search API をブラウザから直接呼び出し、検索結果の書誌情報を集計して表示する。
 * - API キーは利用者が入力したものを使い、このサイトのサーバーには送らない
 * - 扱うのは書誌情報のみ（抄録は取得・表示しない）
 */
(function () {
  "use strict";

  const API_URL = "https://api.elsevier.com/content/search/scopus";
  const PAGE_SIZE = 25;          // COMPLETE ビューの1リクエスト上限
  const CONCURRENCY = 3;         // 年別件数を取りに行く同時リクエスト数（API のスロットリング対策）
  const KEY_STORAGE = "marineTrend.apiKey";
  const RANK_LIMIT = 10;

  const $ = (id) => document.getElementById(id);
  const els = {
    form: $("search-form"), apikey: $("apikey"), remember: $("remember-key"),
    query: $("query"), scope: $("scope"), yearFrom: $("year-from"), yearTo: $("year-to"),
    sampleSize: $("sample-size"), sort: $("sort"), preview: $("query-preview"),
    runBtn: $("run-btn"), demoBtn: $("demo-btn"), cancelBtn: $("cancel-btn"),
    status: $("status"), results: $("results"), dummyBanner: $("dummy-banner"),
    kpis: $("kpis"), trendChart: $("trend-chart"), trendTable: $("trend-table"),
    trendNote: $("trend-note"), toggleTrendTable: $("toggle-trend-table"),
    sampleNote: $("sample-note"), authorsNote: $("authors-note"),
    rankAuthors: $("rank-authors"), rankJournals: $("rank-journals"),
    rankCountries: $("rank-countries"), rankWords: $("rank-words"),
    rankKeywords: $("rank-keywords"), keywordsCard: $("keywords-card"),
    paperRows: $("paper-rows"), filter: $("filter"), tooltip: $("tooltip"),
  };

  const CURRENT_YEAR = new Date().getFullYear();
  let controller = null;
  let lastResult = null;

  // ---------- 初期化 ----------
  els.yearTo.value = CURRENT_YEAR;
  els.yearFrom.value = CURRENT_YEAR - 14;
  try {
    const saved = sessionStorage.getItem(KEY_STORAGE);
    if (saved) { els.apikey.value = saved; els.remember.checked = true; }
  } catch (_) { /* ストレージが使えない環境では無視 */ }

  ["input", "change"].forEach((ev) => {
    els.query.addEventListener(ev, updatePreview);
    els.scope.addEventListener(ev, updatePreview);
    els.yearFrom.addEventListener(ev, updatePreview);
    els.yearTo.addEventListener(ev, updatePreview);
  });
  updatePreview();

  els.remember.addEventListener("change", persistKey);
  els.apikey.addEventListener("change", persistKey);

  els.form.addEventListener("submit", (e) => { e.preventDefault(); runSearch(); });
  els.demoBtn.addEventListener("click", runDemo);
  els.cancelBtn.addEventListener("click", () => controller && controller.abort());
  els.filter.addEventListener("input", () => lastResult && renderPapers(lastResult.papers));
  els.toggleTrendTable.addEventListener("click", () => {
    const show = els.trendTable.hidden;
    els.trendTable.hidden = !show;
    els.trendChart.hidden = show;
    els.toggleTrendTable.textContent = show ? "グラフで見る" : "表で見る";
    els.toggleTrendTable.setAttribute("aria-pressed", String(show));
  });

  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => lastResult && renderTrend(lastResult.years), 150);
  });

  function persistKey() {
    try {
      if (els.remember.checked && els.apikey.value.trim()) {
        sessionStorage.setItem(KEY_STORAGE, els.apikey.value.trim());
      } else {
        sessionStorage.removeItem(KEY_STORAGE);
      }
    } catch (_) { /* 無視 */ }
  }

  // ---------- 検索式 ----------
  function baseQuery() {
    const text = els.query.value.trim();
    if (!text) return "";
    const scope = els.scope.value;
    if (scope === "RAW") return text;
    return `${scope}(${text})`;
  }

  function yearRange() {
    let from = parseInt(els.yearFrom.value, 10);
    let to = parseInt(els.yearTo.value, 10);
    if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
    if (from > to) [from, to] = [to, from];
    if (to - from > 49) from = to - 49; // 年数が多すぎるとリクエストが増えるので上限50年
    return { from, to };
  }

  function rangedQuery(base, range) {
    return `(${base}) AND PUBYEAR > ${range.from - 1} AND PUBYEAR < ${range.to + 1}`;
  }

  function updatePreview() {
    const base = baseQuery();
    const range = yearRange();
    if (!base || !range) { els.preview.textContent = ""; return; }
    els.preview.innerHTML = "実際の検索式：<code></code>";
    els.preview.querySelector("code").textContent = rangedQuery(base, range);
  }

  // ---------- API 呼び出し ----------
  class ApiError extends Error {
    constructor(status, message) { super(message); this.status = status; }
  }

  async function scopusSearch(params, apiKey, signal) {
    const url = new URL(API_URL);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    // ヘッダーではなくクエリパラメーターで渡すと CORS のプリフライトが発生しない
    url.searchParams.set("apiKey", apiKey);
    url.searchParams.set("httpAccept", "application/json");

    let res;
    try {
      res = await fetch(url.toString(), { signal });
    } catch (err) {
      if (err.name === "AbortError") throw err;
      throw new ApiError(0, "network");
    }
    let body = null;
    try { body = await res.json(); } catch (_) { /* JSON 以外 */ }
    if (!res.ok) {
      const st = body && body["service-error"] && body["service-error"].status;
      throw new ApiError(res.status, (st && (st.statusText || st.statusCode)) || res.statusText);
    }
    return body["search-results"];
  }

  function totalOf(sr) {
    return parseInt(sr["opensearch:totalResults"], 10) || 0;
  }

  async function pool(items, limit, worker) {
    const out = new Array(items.length);
    let next = 0;
    async function run() {
      while (next < items.length) {
        const i = next++;
        out[i] = await worker(items[i], i);
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
    return out;
  }

  function explainError(err) {
    if (err instanceof ApiError) {
      switch (err.status) {
        case 0: return "Scopus API に接続できませんでした。ネットワーク接続を確認してください。社外ネットワークや広告ブロッカーの影響、または API キー側の許可ドメイン（CORS）設定が原因の場合もあります。";
        case 400: return `検索式を解釈できませんでした（${err.message}）。詳細検索式の書き方を確認してください。`;
        case 401: return "API キーが無効か、このネットワークからは Scopus の利用権限がありません。キーの値と、契約のある組織のネットワークから接続しているかを確認してください。";
        case 403: return "この操作を行う権限がありません（" + err.message + "）。";
        case 429: return "API の利用上限に達しました（短時間に呼びすぎたか、週ごとの上限）。少し待ってから再度お試しください。";
        default: return `Scopus API がエラーを返しました（${err.status}: ${err.message}）。`;
      }
    }
    return "予期しないエラーが発生しました：" + (err && err.message ? err.message : String(err));
  }

  // ---------- 実行（Scopus） ----------
  async function runSearch() {
    const apiKey = els.apikey.value.trim();
    const base = baseQuery();
    const range = yearRange();
    if (!apiKey) return showStatus("error", "API キーを入力してください。キーがない場合は「ダミーデータで表示」で画面を確認できます。");
    if (!base) return showStatus("error", "検索語を入力してください。");
    if (!range) return showStatus("error", "開始年と終了年を入力してください。");
    persistKey();

    const sampleSize = parseInt(els.sampleSize.value, 10);
    const sort = els.sort.value;
    const years = [];
    for (let y = range.from; y <= range.to; y++) years.push(y);

    controller = new AbortController();
    const signal = controller.signal;
    setBusy(true);

    const totalSteps = years.length + Math.ceil(sampleSize / PAGE_SIZE) + 1;
    let done = 0;
    const tick = (label) => { done++; showProgress(label, done / totalSteps); };

    try {
      showProgress("全体の件数を確認しています…", 0);
      const totalSr = await scopusSearch({ query: rangedQuery(base, range), count: 1, field: "dc:identifier" }, apiKey, signal);
      const totalInRange = totalOf(totalSr);
      tick("年別の件数を集計しています…");

      const counts = await pool(years, CONCURRENCY, async (y) => {
        const sr = await scopusSearch({ query: `(${base}) AND PUBYEAR = ${y}`, count: 1, field: "dc:identifier" }, apiKey, signal);
        tick(`年別の件数を集計しています…（${y}年）`);
        return { year: y, count: totalOf(sr) };
      });

      // 論文サンプル：まず COMPLETE ビュー（全著者・キーワードあり）を試し、権限がなければ STANDARD に切り替える
      let view = "COMPLETE";
      const papers = [];
      const want = Math.min(sampleSize, totalInRange);
      for (let start = 0; start < want; start += PAGE_SIZE) {
        const params = { query: rangedQuery(base, range), count: Math.min(PAGE_SIZE, want - start), start, sort, view };
        let sr;
        try {
          sr = await scopusSearch(params, apiKey, signal);
        } catch (err) {
          if (view === "COMPLETE" && err instanceof ApiError && (err.status === 401 || err.status === 403)) {
            view = "STANDARD";
            params.view = view;
            sr = await scopusSearch(params, apiKey, signal);
          } else {
            throw err;
          }
        }
        (sr.entry || []).forEach((e) => { if (!e.error) papers.push(normalizeEntry(e)); });
        tick(`論文の書誌情報を取得しています…（${papers.length}件）`);
        if (!sr.entry || sr.entry.length === 0) break;
      }

      hideStatus();
      if (totalInRange === 0) {
        showStatus("warn", "条件に合う論文が見つかりませんでした。検索語や期間を変えてお試しください。");
        els.results.hidden = true;
        return;
      }
      render({
        dummy: false, query: rangedQuery(base, range), range, years: counts,
        totalInRange, papers, view, sort,
      });
      if (view === "STANDARD") {
        showStatus("warn", "この接続では詳細ビュー（全著者・著者キーワード）の権限がないため、簡易ビューで取得しました。著者の集計は各論文の筆頭著者のみが対象です。");
      }
    } catch (err) {
      if (err.name === "AbortError") showStatus("warn", "中止しました。");
      else showStatus("error", explainError(err));
    } finally {
      setBusy(false);
      controller = null;
    }
  }

  function normalizeEntry(e) {
    const links = Array.isArray(e.link) ? e.link : [];
    const scopusLink = links.find((l) => l["@ref"] === "scopus");
    const authorsFull = Array.isArray(e.author)
      ? e.author.map((a) => ({ name: a.authname || [a["given-name"], a.surname].filter(Boolean).join(" "), id: a.authid || "" }))
      : null;
    const affils = Array.isArray(e.affiliation) ? e.affiliation : [];
    const countries = [...new Set(affils.map((a) => a["affiliation-country"]).filter(Boolean))];
    const keywords = typeof e.authkeywords === "string"
      ? e.authkeywords.split("|").map((s) => s.trim()).filter(Boolean)
      : [];
    return {
      // Scopus のタイトルには <inf> などの書式タグが入ることがあるので除去する
      title: (e["dc:title"] || "(タイトルなし)").replace(/<[^>]*>/g, ""),
      year: (e["prism:coverDate"] || "").slice(0, 4),
      journal: e["prism:publicationName"] || "",
      cited: parseInt(e["citedby-count"], 10) || 0,
      doi: e["prism:doi"] || "",
      type: e.subtypeDescription || "",
      url: scopusLink && /^https:\/\//.test(scopusLink["@href"]) ? scopusLink["@href"] : "",
      authors: authorsFull && authorsFull.length ? authorsFull : (e["dc:creator"] ? [{ name: e["dc:creator"], id: "" }] : []),
      firstAuthorOnly: !(authorsFull && authorsFull.length),
      countries,
      keywords,
    };
  }

  // ---------- 実行（ダミー） ----------
  function runDemo() {
    const range = yearRange() || { from: CURRENT_YEAR - 14, to: CURRENT_YEAR };
    const data = makeDummy(range, parseInt(els.sampleSize.value, 10));
    hideStatus();
    render(data);
  }

  function makeDummy(range, n) {
    let seed = 20261022;
    const rnd = () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
    const years = [];
    for (let y = range.from; y <= range.to; y++) {
      const t = y - range.from;
      let c = Math.round(40 + t * t * 3.2 + rnd() * 30);
      if (y === CURRENT_YEAR) c = Math.round(c * 0.8);
      years.push({ year: y, count: c });
    }
    const topics = ["marine heatwaves", "coral bleaching", "ocean acidification", "kelp forest decline", "seagrass carbon storage", "fisheries productivity", "deep-sea biodiversity", "sea surface temperature extremes", "plankton community shifts", "coastal hypoxia"];
    const verbs = ["Drivers of", "Long-term trends in", "Ecological impacts of", "Predicting", "Monitoring", "Regional patterns of", "Recovery after"];
    const places = ["the North Pacific", "the Kuroshio region", "temperate reefs", "the Mediterranean Sea", "Arctic shelf seas", "tropical coasts", "the Southern Ocean"];
    const journals = ["Demo Journal of Ocean Science", "Sample Marine Ecology Letters", "Example Reviews in Oceanography", "Placeholder Coastal Research", "Mock Fisheries Journal", "Test Journal of Climate and Sea"];
    const authors = Array.from({ length: 28 }, (_, i) => `Author ${String.fromCharCode(65 + (i % 26))}${i >= 26 ? "2" : ""}`);
    const countries = ["Japan", "United States", "Australia", "China", "United Kingdom", "Germany", "Spain", "Canada", "France", "South Korea"];
    const kws = ["climate change", "marine heatwave", "biodiversity", "remote sensing", "ocean warming", "ecosystem model", "fisheries", "coral reef", "time series", "adaptation"];
    const papers = Array.from({ length: n }, () => {
      const nA = 2 + Math.floor(rnd() * 5);
      const as = [];
      while (as.length < nA) { const a = pick(authors.slice(0, 8 + Math.floor(rnd() * 20))); if (!as.includes(a)) as.push(a); }
      const year = range.from + Math.floor(Math.pow(rnd(), 0.5) * (range.to - range.from + 1));
      return {
        title: `${pick(verbs)} ${pick(topics)} in ${pick(places)}`,
        year: String(Math.min(year, range.to)),
        journal: pick(journals.slice(0, 3 + Math.floor(rnd() * 4))),
        cited: Math.floor(Math.pow(rnd(), 3) * 400),
        doi: "", type: "Article", url: "",
        authors: as.map((name) => ({ name, id: "" })),
        firstAuthorOnly: false,
        countries: [...new Set([pick(countries.slice(0, 4)), pick(countries)])],
        keywords: [...new Set([pick(kws), pick(kws), pick(kws)])],
      };
    }).sort((a, b) => b.cited - a.cited);
    const total = years.reduce((s, y) => s + y.count, 0);
    return { dummy: true, query: "(ダミーデータ)", range, years, totalInRange: total, papers, view: "COMPLETE", sort: "-citedby-count" };
  }

  // ---------- 描画 ----------
  function render(data) {
    lastResult = data;
    els.results.hidden = false;
    els.dummyBanner.hidden = !data.dummy;
    els.filter.value = "";
    renderKpis(data);
    renderTrend(data.years);
    renderTrendTable(data.years);
    renderRankings(data);
    renderPapers(data.papers);
    els.results.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function fmt(n) { return Number(n).toLocaleString("ja-JP"); }

  function renderKpis(data) {
    const ys = data.years.filter((y) => y.year < CURRENT_YEAR);
    const peak = data.years.reduce((m, y) => (y.count > m.count ? y : m), data.years[0]);
    let growth = "—", growthSub = "比較できる年が不足";
    if (ys.length >= 6) {
      const last = ys.slice(-3).reduce((s, y) => s + y.count, 0);
      const prev = ys.slice(-6, -3).reduce((s, y) => s + y.count, 0);
      if (prev > 0) {
        const pct = Math.round((last / prev - 1) * 100);
        growth = (pct >= 0 ? "+" : "") + pct + "%";
        growthSub = `${ys[ys.length - 3].year}–${ys[ys.length - 1].year}年 と その前の3年の比較`;
      }
    }
    const items = [
      { label: "期間内の論文数", value: fmt(data.totalInRange), sub: `${data.range.from}–${data.range.to}年` },
      { label: "最も多かった年", value: peak ? `${peak.year}年` : "—", sub: peak ? `${fmt(peak.count)}件` : "" },
      { label: "直近3年の伸び", value: growth, sub: growthSub },
      { label: "詳しく分析した論文", value: `${fmt(data.papers.length)}件`, sub: sortLabel(data.sort) + "の上位" },
    ];
    els.kpis.innerHTML = items.map((k) =>
      `<div class="kpi"><div class="label">${esc(k.label)}</div><div class="value">${esc(k.value)}</div><div class="sub">${esc(k.sub)}</div></div>`
    ).join("");
  }

  function sortLabel(s) {
    return { "-citedby-count": "被引用数順", "-coverDate": "新しい順", relevancy: "関連度順" }[s] || "";
  }

  function niceMax(v) {
    if (v <= 0) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    const m = v / p;
    const step = m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10;
    return step * p;
  }

  function renderTrend(years) {
    const box = els.trendChart;
    const W = Math.max(300, box.clientWidth || 600);
    const H = 260;
    const m = { t: 22, r: 8, b: 28, l: 46 };
    const iw = W - m.l - m.r, ih = H - m.t - m.b;
    const max = niceMax(Math.max(...years.map((y) => y.count)) * 1.08);
    const band = iw / years.length;
    const bw = Math.max(3, Math.min(36, band * 0.7));
    const y = (v) => m.t + ih - (v / max) * ih;
    const ticks = 4;
    const labelEvery = band >= 34 ? 1 : band >= 18 ? 2 : 5;
    const peakIdx = years.reduce((bi, d, i) => (d.count > years[bi].count ? i : bi), 0);
    const hasPartial = years.some((d) => d.year === CURRENT_YEAR);

    let svg = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="年別の論文数の棒グラフ">`;
    svg += `<g class="axis">`;
    for (let i = 0; i <= ticks; i++) {
      const v = (max / ticks) * i;
      const yy = y(v);
      if (i > 0) svg += `<line class="gridline" x1="${m.l}" x2="${W - m.r}" y1="${yy}" y2="${yy}"/>`;
      svg += `<text x="${m.l - 6}" y="${yy + 4}" text-anchor="end">${fmt(Math.round(v))}</text>`;
    }
    years.forEach((d, i) => {
      if (i % labelEvery !== 0 && i !== years.length - 1) return;
      svg += `<text x="${m.l + band * i + band / 2}" y="${H - 8}" text-anchor="middle">${d.year}</text>`;
    });
    svg += `</g>`;
    years.forEach((d, i) => {
      const x = m.l + band * i + (band - bw) / 2;
      const top = y(d.count);
      const h = m.t + ih - top;
      const r = Math.min(4, bw / 2, h);
      const cls = d.year === CURRENT_YEAR ? "bar partial" : "bar";
      const path = h <= 0 ? "" :
        `M${x},${m.t + ih} V${top + r} Q${x},${top} ${x + r},${top} H${x + bw - r} Q${x + bw},${top} ${x + bw},${top + r} V${m.t + ih} Z`;
      svg += `<path class="${cls}" data-i="${i}" d="${path}"/>`;
      if (i === peakIdx) svg += `<text class="peak-label" x="${x + bw / 2}" y="${top - 6}" text-anchor="middle">${fmt(d.count)}</text>`;
    });
    svg += `<line class="baseline" x1="${m.l}" x2="${W - m.r}" y1="${m.t + ih}" y2="${m.t + ih}"/>`;
    years.forEach((d, i) => {
      svg += `<rect class="hit" data-i="${i}" x="${m.l + band * i}" y="${m.t}" width="${band}" height="${ih}"/>`;
    });
    svg += `</svg>`;
    box.innerHTML = svg;

    els.trendNote.textContent = hasPartial
      ? `${CURRENT_YEAR}年は年の途中のため、薄い色で表示しています（今後まだ増えます）。`
      : "";

    const bars = box.querySelectorAll(".bar");
    box.querySelectorAll(".hit").forEach((hit) => {
      const i = +hit.dataset.i;
      const d = years[i];
      hit.addEventListener("mousemove", (ev) => {
        bars.forEach((b) => b.classList.toggle("hover", +b.dataset.i === i));
        showTip(ev, `<strong>${d.year}年</strong><br>${fmt(d.count)}件${d.year === CURRENT_YEAR ? "（年途中）" : ""}`);
      });
      hit.addEventListener("mouseleave", () => { bars.forEach((b) => b.classList.remove("hover")); hideTip(); });
    });
  }

  function renderTrendTable(years) {
    els.trendTable.innerHTML =
      `<table><thead><tr><th scope="col">年</th><th scope="col" class="num">論文数</th></tr></thead><tbody>` +
      years.map((d) => `<tr><td>${d.year}${d.year === CURRENT_YEAR ? "（年途中）" : ""}</td><td class="num">${fmt(d.count)}</td></tr>`).join("") +
      `</tbody></table>`;
  }

  function showTip(ev, html) {
    const t = els.tooltip;
    t.innerHTML = html;
    t.hidden = false;
    const pad = 12;
    let x = ev.clientX + pad, y = ev.clientY + pad;
    const r = t.getBoundingClientRect();
    if (x + r.width > window.innerWidth - 8) x = ev.clientX - r.width - pad;
    if (y + r.height > window.innerHeight - 8) y = ev.clientY - r.height - pad;
    t.style.left = x + "px"; t.style.top = y + "px";
  }
  function hideTip() { els.tooltip.hidden = true; }

  // ---------- 集計 ----------
  const STOPWORDS = new Set((
    "a an the and or of in on for to from with by at as into via between among under over within without " +
    "its their our this that these those is are was were be been being has have had not no new using use based " +
    "study studies analysis approach case review effect effects impact impacts role toward towards evidence " +
    "assessment evaluation investigation research results data model models modeling modelling during after " +
    "across along through than more less high low different various two three first how what why when where which"
  ).split(" "));

  function countBy(items, keyFn, labelFn) {
    const map = new Map();
    items.forEach((it) => {
      const k = keyFn(it);
      if (!k) return;
      const cur = map.get(k) || { label: labelFn ? labelFn(it) : k, count: 0 };
      cur.count++;
      map.set(k, cur);
    });
    return [...map.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  }

  function renderRankings(data) {
    const papers = data.papers;
    const authorItems = papers.flatMap((p) => p.authors);
    renderRank(els.rankAuthors, countBy(authorItems, (a) => a.id || a.name.toLowerCase(), (a) => a.name), "件");
    const firstOnly = papers.length && papers.every((p) => p.firstAuthorOnly);
    els.authorsNote.textContent = firstOnly
      ? "簡易ビューのため、各論文の筆頭著者のみで集計しています。"
      : "共著者を含むすべての著者で集計しています。";

    renderRank(els.rankJournals, countBy(papers, (p) => p.journal), "件");
    renderRank(els.rankCountries, countBy(papers.flatMap((p) => p.countries), (c) => c), "件");

    const words = papers.flatMap((p) => {
      const ws = p.title.toLowerCase().replace(/<[^>]*>/g, " ").match(/[a-z][a-z\-]+[a-z]/g) || [];
      return [...new Set(ws.filter((w) => w.length >= 3 && !STOPWORDS.has(w)))];
    });
    renderRank(els.rankWords, countBy(words, (w) => w), "件");

    const kws = papers.flatMap((p) => [...new Set(p.keywords.map((k) => k.toLowerCase()))]);
    els.keywordsCard.hidden = kws.length === 0;
    if (kws.length) renderRank(els.rankKeywords, countBy(kws, (k) => k), "件");

    els.sampleNote.textContent =
      `以下は、期間内の ${fmt(data.totalInRange)} 件のうち、${sortLabel(data.sort)}で上位 ${fmt(papers.length)} 件の論文を集計したものです。`;
  }

  function renderRank(ol, rows, unit) {
    const top = rows.slice(0, RANK_LIMIT);
    if (!top.length) { ol.innerHTML = `<li><span class="empty">データがありません</span></li>`; return; }
    const max = top[0].count;
    ol.innerHTML = top.map((r, i) =>
      `<li><span class="no">${i + 1}</span><span class="name" title="${esc(r.label)}">${esc(r.label)}</span>` +
      `<span class="count">${fmt(r.count)}${unit}</span>` +
      `<span class="track" aria-hidden="true"><span class="fill" style="width:${(r.count / max) * 100}%"></span></span></li>`
    ).join("");
  }

  function renderPapers(papers) {
    const q = els.filter.value.trim().toLowerCase();
    const rows = q
      ? papers.filter((p) => (p.title + " " + p.journal + " " + p.authors.map((a) => a.name).join(" ")).toLowerCase().includes(q))
      : papers;
    if (!rows.length) {
      els.paperRows.innerHTML = `<tr><td colspan="5" class="hint">該当する論文がありません</td></tr>`;
      return;
    }
    els.paperRows.innerHTML = rows.map((p) => {
      const names = p.authors.map((a) => a.name);
      const authors = names.length > 4 ? names.slice(0, 4).join(", ") + ` ほか${names.length - 4}名` : names.join(", ");
      const title = p.url
        ? `<a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.title)}</a>`
        : esc(p.title);
      const meta = [p.type, p.doi ? `DOI: ${p.doi}` : ""].filter(Boolean).join(" ・ ");
      return `<tr><td>${esc(p.year)}</td><td class="title">${title}${meta ? `<div class="meta">${esc(meta)}</div>` : ""}</td>` +
        `<td class="authors">${esc(authors)}</td><td class="journal">${esc(p.journal)}</td><td class="num">${fmt(p.cited)}</td></tr>`;
    }).join("");
  }

  // ---------- UI ヘルパー ----------
  function setBusy(busy) {
    els.runBtn.disabled = busy;
    els.demoBtn.disabled = busy;
    els.cancelBtn.hidden = !busy;
  }

  function showStatus(kind, text) {
    els.status.hidden = false;
    els.status.className = "status" + (kind ? " " + kind : "");
    els.status.textContent = text;
  }

  function showProgress(text, ratio) {
    els.status.hidden = false;
    els.status.className = "status";
    els.status.innerHTML = `<div></div><div class="progress"><span></span></div>`;
    els.status.firstChild.textContent = text;
    els.status.querySelector(".progress > span").style.width = Math.round(Math.min(1, ratio) * 100) + "%";
  }

  function hideStatus() { els.status.hidden = true; }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
})();
