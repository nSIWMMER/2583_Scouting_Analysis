// ------------------------------------------------------------------
// FRC Scouting — Analysis Dashboard
// Reads data from the Apps Script backend (same one the scouting app
// writes to) and from The Blue Alliance's public API.
// ------------------------------------------------------------------

const SETTINGS_KEY = 'frc-analysis-settings'; // apiUrl — not sensitive enough to warrant session-only storage
const SESSION_PW_KEY = 'frc-analysis-password'; // sessionStorage — cleared when tab closes

// Baked in so scouts/mentors don't have to type a TBA key in Settings.
// This is a read-only TBA key (can't modify any data), so the exposure risk
// of it living in this public source file is low — but it's not a secret
// either, so don't treat it as one going forward.
const DEFAULT_TBA_KEY = 'qymxUzAK4Jkxybxb6CZ8bmkiyi4LxFLy3l3AjUoVWH3V6wSlSCLgBQsTKbs86Soo';

let rawData = [];        // all rows fetched from the sheet
let compareChart = null; // Chart.js instances, recreated on redraw
let teamFuelChart = null;

// ---------- Settings ----------

function getSettings() {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; }
  catch { return {}; }
}

function saveSettings(settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

function getPassword() {
  return sessionStorage.getItem(SESSION_PW_KEY) || '';
}

// ---------- Data fetch ----------

async function fetchScoutingData(apiUrl, password) {
  const url = apiUrl + (apiUrl.includes('?') ? '&' : '?') + 'password=' + encodeURIComponent(password);
  const res = await fetch(url);
  const json = await res.json();
  if (json.status !== 'ok') throw new Error(json.message || 'Failed to fetch data');
  return json.data;
}

// ---------- Metric helpers ----------

function num(v) {
  const n = parseFloat(v);
  return isNaN(n) ? 0 : n;
}

function totalFuel(row) {
  return num(row.auto_score) + (num(row.teleop_score) * num(row.cycles_per_match));
}

const CLIMB_LEVEL = { 'None': 0, 'Failed Climb': 0, 'L1': 1, 'L2': 2, 'L3': 3 };
const CLIMB_LABEL = { 0: 'None', 1: 'L1', 2: 'L2', 3: 'L3' };

function climbLevel(status) {
  return CLIMB_LEVEL.hasOwnProperty(status) ? CLIMB_LEVEL[status] : 0;
}

function uniqueTeams(data) {
  const teams = [...new Set(data.map((r) => String(r.team_number)).filter(Boolean))];
  return teams.sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
}

// Converts a Drive "view" link into an embeddable thumbnail URL.
function driveThumbnail(url) {
  if (!url) return null;
  const match = url.match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (!match) return url;
  return 'https://drive.google.com/thumbnail?id=' + match[1] + '&sz=w200';
}

// ---------- Compare Teams tab ----------

let showCompareDetails = false; // toggled by the Show Details button

function computeStats(values) {
  const n = values.length;
  const mean = values.reduce((s, v) => s + v, 0) / n;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
  const std = Math.sqrt(variance);
  return { mean, min, max, std };
}

// Percentile with linear interpolation, on a pre-sorted array.
function percentile(sorted, p) {
  const n = sorted.length;
  if (n === 1) return sorted[0];
  const idx = (p / 100) * (n - 1);
  const lower = Math.floor(idx);
  const upper = Math.ceil(idx);
  if (lower === upper) return sorted[lower];
  const frac = idx - lower;
  return sorted[lower] + (sorted[upper] - sorted[lower]) * frac;
}

// Real statistical quartile boundaries — each of the 4 resulting bands
// (min→q1, q1→median, median→q3, q3→max) always contains exactly 25% of
// the values by construction, so the *height* of each band on the chart
// reflects how spread out that quarter of the data actually is: tightly
// clustered values produce a short band, widely spread values a tall one.
function computeQuartileBoundaries(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    q1: percentile(sorted, 25),
    median: percentile(sorted, 50),
    q3: percentile(sorted, 75)
  };
}

// Returns one row per team with mean/min/max/std for the selected metric,
// sorted highest-mean-first (so the chart reads high-to-low, left-to-right).
function buildCompareDataset(mode) {
  const teams = uniqueTeams(rawData);
  const rows = teams.map((team) => {
    const teamRows = rawData.filter((r) => String(r.team_number) === team);
    let values;
    if (mode === 'fuel') values = teamRows.map((r) => totalFuel(r));
    else if (mode === 'defense') values = teamRows.map((r) => num(r.defense_rating));
    else if (mode === 'endgame') values = teamRows.map((r) => climbLevel(r.endgame_status));
    const stats = computeStats(values);
    const quartiles = computeQuartileBoundaries(values);
    return { team, ...stats, ...quartiles };
  });
  rows.sort((a, b) => b.mean - a.mean);
  return rows;
}

// Generates a distinct color for each team by rotating around the color
// wheel — spreads hues evenly so adjacent teams don't look similar even
// with a large roster.
function colorForIndex(i, total) {
  const hue = Math.round((360 * i) / Math.max(total, 1));
  return `hsl(${hue}, 70%, 60%)`;
}

// Draws a horizontal pill-shaped rectangle — rounded left/right ends —
// matching the rounded bar segments in the sketch.
function drawRoundedBar(ctx, x, y, width, height, fillStyle) {
  const r = Math.min(height / 2, width / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.arcTo(x + width, y, x + width, y + r, r);
  ctx.lineTo(x + width, y + height - r);
  ctx.arcTo(x + width, y + height, x + width - r, y + height, r);
  ctx.lineTo(x + r, y + height);
  ctx.arcTo(x, y + height, x, y + height - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
  ctx.fillStyle = fillStyle;
  ctx.fill();
}

function renderCompareChart() {
  const mode = document.getElementById('graphSelect').value;
  const dataset = buildCompareDataset(mode);
  const ctx = document.getElementById('compareChart').getContext('2d');
  const colors = dataset.map((_, i) => colorForIndex(i, dataset.length));
  const labels = dataset.map((d) => 'Team ' + d.team);

  // Full min/max/std-dev/quarter breakdown only applies to Total Fuel
  // Scored — Defense and Endgame just show the average, kept simple.
  const detailedMode = mode === 'fuel';
  document.getElementById('detailsToggleBtn').style.display = detailedMode ? 'inline-block' : 'none';

  const labelForMode = {
    fuel: 'Avg Total Fuel Scored',
    defense: 'Avg Defense Rating',
    endgame: 'Avg Endgame Climb'
  }[mode];

  const rangeData = dataset.map((d) => [d.min, d.max]);
  const FIXED_MEAN_PIXEL_HEIGHT = 18; // a bit taller than before

  // Everything visual — the quartered min→max block AND the bright mean
  // bar — is hand-drawn here on top of one fully-transparent placeholder
  // bar per team. Using a single dataset (rather than separate ones for
  // range/mean) guarantees exactly one column per team, with no risk of
  // Chart.js laying out multiple datasets side-by-side instead of on top
  // of each other.
  const compareChartPlugin = {
    id: 'compareChartExtras',
    afterDatasetsDraw(chart) {
      const meta = chart.getDatasetMeta(0);
      const yScale = chart.scales.y;

      meta.data.forEach((bar, i) => {
        const d = dataset[i];
        const x = bar.x;
        const width = bar.width;
        const yMinPixel = yScale.getPixelForValue(d.min);
        const yMaxPixel = yScale.getPixelForValue(d.max);
        const top = Math.min(yMinPixel, yMaxPixel);
        const bottom = Math.max(yMinPixel, yMaxPixel);

        if (detailedMode && showCompareDetails) {
          // 5 boundary pixel positions from real quartile values — each of
          // the 4 resulting bands always contains exactly 25% of matches,
          // so a band's height now shows how spread out that quarter of
          // the data actually is (tight cluster = short band).
          const yQ1 = yScale.getPixelForValue(d.q1);
          const yMedian = yScale.getPixelForValue(d.median);
          const yQ3 = yScale.getPixelForValue(d.q3);
          const boundaries = [top, ...[yQ1, yMedian, yQ3].sort((a, b) => a - b), bottom];

          const quarterOpacities = [0.3, 0.55, 0.55, 0.3]; // top-to-bottom
          ctx.save();
          for (let q = 0; q < 4; q++) {
            const segTop = boundaries[q];
            const segBottom = boundaries[q + 1];
            const fill = colors[i].replace('60%)', `60%, ${quarterOpacities[q]})`).replace('hsl', 'hsla');
            drawRoundedBar(ctx, x - width / 2, segTop, width, segBottom - segTop, fill);
          }
          ctx.restore();

          // 5 boundary lines: max (top), q3, median, q1, min (bottom) —
          // colored to match this team, at an opacity between the shading
          // (below) and the solid mean bar (above). Rounded caps on the ends.
          ctx.save();
          ctx.strokeStyle = colors[i].replace('60%)', '60%, 0.7)').replace('hsl', 'hsla');
          ctx.lineWidth = 2;
          ctx.lineCap = 'round';
          boundaries.forEach((yLine) => {
            ctx.beginPath();
            ctx.moveTo(x - width / 2, yLine);
            ctx.lineTo(x + width / 2, yLine);
            ctx.stroke();
          });
          ctx.restore();
        }

        // Bright mean bar, fixed pixel height, drawn as a rounded pill —
        // matches the old dot's diameter, always drawn on top.
        const yMeanPixel = yScale.getPixelForValue(d.mean);
        const halfHeight = FIXED_MEAN_PIXEL_HEIGHT / 2;
        ctx.save();
        drawRoundedBar(ctx, x - width / 2, yMeanPixel - halfHeight, width, FIXED_MEAN_PIXEL_HEIGHT, colors[i]);
        ctx.restore();
      });
    }
  };

  // Fixed ~1 CSS inch (96px) per team column, regardless of team count —
  // the wrapping div scrolls horizontally if this exceeds the viewport.
  // (Note: CSS "inches" are a fixed 96px-per-inch convention per spec, not
  // a measurement of your actual screen's physical DPI — browsers don't
  // reliably know a display's true pixel density, so this is the closest
  // consistent approximation available on the web.)
  document.getElementById('compareChartInner').style.width = (dataset.length * 96 * 1.5) + 'px';

  if (compareChart) compareChart.destroy();
  compareChart = new Chart(ctx, {
    type: 'bar',
    plugins: [compareChartPlugin],
    data: {
      labels,
      datasets: [{
        label: labelForMode,
        data: rangeData,
        backgroundColor: 'transparent',
        borderWidth: 0,
        barPercentage: 0.9,
        categoryPercentage: 0.9
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: {
          ticks: { color: '#8b9198' },
          grid: { color: '#323942' }
        },
        y: {
          ticks: {
            color: '#8b9198',
            stepSize: mode === 'endgame' ? 1 : undefined,
            callback: mode === 'endgame' ? (val) => Number.isInteger(val) ? val : '' : undefined
          },
          grid: { color: '#323942' },
          ...(mode === 'endgame' ? { min: -0.5, max: 3.5 } : {})
        }
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const d = dataset[ctx.dataIndex];
              if (!detailedMode) return ['Team ' + d.team, 'Mean: ' + d.mean.toFixed(2)];
              return [
                'Team ' + d.team,
                'Mean: ' + d.mean.toFixed(2),
                'Min: ' + d.min.toFixed(2),
                'Max: ' + d.max.toFixed(2),
                'Std Dev: ' + d.std.toFixed(2),
                'Q1 / Median / Q3: ' + d.q1.toFixed(2) + ' / ' + d.median.toFixed(2) + ' / ' + d.q3.toFixed(2)
              ];
            }
          }
        }
      },
      onClick: (evt, elements) => {
        const infoEl = document.getElementById('pointInfo');
        if (!elements.length) { infoEl.classList.remove('show'); return; }
        const d = dataset[elements[0].index];
        if (!detailedMode) {
          infoEl.textContent = 'Team ' + d.team + ' — ' + labelForMode + ' — Mean: ' + d.mean.toFixed(2);
          infoEl.classList.add('show');
          return;
        }
        infoEl.textContent = 'Team ' + d.team + ' — ' + labelForMode +
          ' — Mean: ' + d.mean.toFixed(2) +
          ', Min: ' + d.min.toFixed(2) +
          ', Max: ' + d.max.toFixed(2) +
          ', Std Dev: ' + d.std.toFixed(2) +
          ' — Q1 / Median / Q3: ' + d.q1.toFixed(2) + ' / ' + d.median.toFixed(2) + ' / ' + d.q3.toFixed(2);
        infoEl.classList.add('show');
      }
    }
  });
}

// ---------- Team Detail tab ----------

function populateTeamSelect() {
  const select = document.getElementById('teamSelect');
  const teams = uniqueTeams(rawData);
  select.innerHTML = '<option value="">— choose a team —</option>' +
    teams.map((t) => `<option value="${t}">Team ${t}</option>`).join('');
}

function renderTeamDetail(team) {
  const rows = rawData.filter((r) => String(r.team_number) === team);
  document.getElementById('teamDetailEmpty').style.display = rows.length ? 'none' : 'block';
  document.getElementById('teamDetailContent').style.display = rows.length ? 'block' : 'none';
  if (!rows.length) return;

  // Chart: fuel per match
  const points = rows.map((r) => ({
    label: (r.match_type || '') + (r.match_number || ''),
    value: totalFuel(r)
  }));
  const ctx = document.getElementById('teamFuelChart').getContext('2d');
  if (teamFuelChart) teamFuelChart.destroy();
  teamFuelChart = new Chart(ctx, {
    type: 'scatter',
    data: {
      datasets: [{
        label: 'Total Fuel Scored',
        data: points.map((p, i) => ({ x: i, y: p.value })),
        backgroundColor: '#12b304',
        pointRadius: 6
      }]
    },
    options: {
      responsive: true,
      scales: {
        x: {
          ticks: { callback: (val) => (points[val] ? points[val].label : ''), color: '#8b9198' },
          grid: { color: '#323942' }
        },
        y: { ticks: { color: '#8b9198' }, grid: { color: '#323942' } }
      },
      plugins: { legend: { labels: { color: '#e8e6e1' } } }
    }
  });

  // Summary table
  const brokeDownCount = rows.filter((r) => r.broke_down === 'YES').length;
  const highestClimb = Math.max(...rows.map((r) => climbLevel(r.endgame_status)));
  document.getElementById('teamBrokeDown').textContent = brokeDownCount;
  document.getElementById('teamHighestClimb').textContent = CLIMB_LABEL[highestClimb];

  // Notes + photos
  const notesList = document.getElementById('teamNotesList');
  notesList.innerHTML = rows.map((r) => {
    const thumb = driveThumbnail(r.photo_url);
    const photoHtml = thumb
      ? `<a href="${r.photo_url}" target="_blank"><img class="note-photo" src="${thumb}" alt="photo" /></a>`
      : '';
    return `
      <div class="note-entry">
        ${photoHtml}
        <div>
          <div class="note-meta">${r.match_type || ''} ${r.match_number || ''} — ${r.scouter_name || 'unknown'}</div>
          <div class="note-text">${(r.notes || '').replace(/</g, '&lt;') || '<em>No notes</em>'}</div>
        </div>
      </div>`;
  }).join('') || '<p class="empty-state">No notes yet.</p>';

  // Scouters
  const scouters = [...new Set(rows.map((r) => r.scouter_name).filter(Boolean))];
  document.getElementById('teamScoutersList').innerHTML = scouters.length
    ? scouters.map((s) => `<span class="scouter-chip">${s}</span>`).join('')
    : '<p class="empty-state">No scouter names recorded.</p>';
}

// ---------- Event Rankings tab (The Blue Alliance) ----------

let loadedEvents = [];      // events for the currently loaded year
let selectedEventKey = null;
let rankingsData = [];      // merged rankings + OPR, current event
let sortState = { key: 'rank', dir: 'asc' };

async function tbaFetch(path) {
  const settings = getSettings();
  const key = settings.tbaKey || DEFAULT_TBA_KEY;
  const res = await fetch('https://www.thebluealliance.com/api/v3' + path, {
    headers: { 'X-TBA-Auth-Key': key }
  });
  if (!res.ok) throw new Error('TBA request failed (' + res.status + ')');
  return res.json();
}

async function loadEventsForYear(year) {
  loadedEvents = await tbaFetch('/events/' + year + '/simple');
  loadedEvents.sort((a, b) => (a.name > b.name ? 1 : -1));
  document.getElementById('eventSearchRow').style.display = 'flex';
  document.getElementById('eventSearchInput').value = '';
  document.getElementById('eventResultsList').innerHTML = '';
  document.getElementById('selectedEventLabel').textContent = '';
}

function renderEventResults(filterText) {
  const list = document.getElementById('eventResultsList');
  const text = filterText.trim().toLowerCase();
  if (!text) { list.innerHTML = ''; return; }

  const matches = loadedEvents
    .filter((e) => e.name.toLowerCase().includes(text) || e.key.toLowerCase().includes(text))
    .slice(0, 25);

  list.innerHTML = matches.length
    ? matches.map((e) => `<div class="event-result-item" data-key="${e.key}" data-name="${e.name.replace(/"/g, '&quot;')}">${e.name}</div>`).join('')
    : '<div class="empty-state">No matching events.</div>';

  list.querySelectorAll('.event-result-item').forEach((item) => {
    item.addEventListener('click', async () => {
      selectedEventKey = item.dataset.key;
      document.getElementById('selectedEventLabel').textContent = 'Selected: ' + item.dataset.name;
      list.innerHTML = '';
      document.getElementById('eventSearchInput').value = item.dataset.name;
      try {
        await loadRankingsForEvent(selectedEventKey);
      } catch (err) {
        alert(err.message);
      }
    });
  });
}

// Finds the index in sort_order_info whose name matches a pattern, so we
// read TBA's own official per-game ranking stats by name rather than
// assuming a fixed position (this year's game happens to expose "Avg Match",
// "Avg Auto Fuel", and "Avg Tower" as ranking criteria — TBA computes these
// officially, so we use their numbers directly instead of recomputing from
// raw match data).
function findSortOrderIndex(sortOrderInfo, pattern) {
  if (!sortOrderInfo) return -1;
  return sortOrderInfo.findIndex((info) => pattern.test(info.name));
}

async function loadRankingsForEvent(eventKey) {
  const [rankingsRes, oprsRes] = await Promise.all([
    tbaFetch('/event/' + eventKey + '/rankings'),
    tbaFetch('/event/' + eventKey + '/oprs').catch(() => ({ oprs: {} }))
  ]);

  const oprs = oprsRes && oprsRes.oprs ? oprsRes.oprs : {};
  const rankings = (rankingsRes && rankingsRes.rankings) || [];
  const sortOrderInfo = rankingsRes && rankingsRes.sort_order_info;

  const idxRankingScore = 0; // TBA always puts the primary ranking criterion first
  const idxAvgMatch = findSortOrderIndex(sortOrderInfo, /avg.*match/i);
  const idxAvgAutoFuel = findSortOrderIndex(sortOrderInfo, /auto.*fuel/i);
  const idxAvgTower = findSortOrderIndex(sortOrderInfo, /tower/i);

  const sortOrderVal = (r, idx) => (idx >= 0 && r.sort_orders && r.sort_orders[idx] !== undefined) ? r.sort_orders[idx] : 0;

  rankingsData = rankings.map((r) => ({
    rank: r.rank,
    team: parseInt(r.team_key.replace('frc', ''), 10),
    wins: r.record ? r.record.wins : 0,
    losses: r.record ? r.record.losses : 0,
    ties: r.record ? r.record.ties : 0,
    played: r.matches_played != null ? r.matches_played : 0,
    rankingScore: sortOrderVal(r, idxRankingScore),
    opr: oprs[r.team_key] || 0,
    avgMatch: sortOrderVal(r, idxAvgMatch),
    avgAutoFuel: sortOrderVal(r, idxAvgAutoFuel),
    avgTower: sortOrderVal(r, idxAvgTower)
  }));

  sortState = { key: 'rank', dir: 'asc' };
  renderRankingsTable();
  document.getElementById('rankingsCard').style.display = 'block';
}

function renderRankingsTable() {
  const sorted = [...rankingsData].sort((a, b) => {
    const dir = sortState.dir === 'asc' ? 1 : -1;
    return (a[sortState.key] - b[sortState.key]) * dir;
  });

  document.querySelectorAll('#rankingsTable th.sortable').forEach((th) => {
    th.classList.remove('sort-asc', 'sort-desc');
    if (th.dataset.key === sortState.key) th.classList.add(sortState.dir === 'asc' ? 'sort-asc' : 'sort-desc');
  });

  const tbody = document.querySelector('#rankingsTable tbody');
  tbody.innerHTML = sorted.length
    ? sorted.map((r) => `
      <tr>
        <td class="mono">${r.rank}</td>
        <td class="mono">${r.team}</td>
        <td class="mono">${r.wins}-${r.losses}-${r.ties}</td>
        <td class="mono">${r.played}</td>
        <td class="mono">${r.rankingScore.toFixed(2)}</td>
        <td class="mono">${r.opr.toFixed(1)}</td>
        <td class="mono">${r.avgMatch.toFixed(2)}</td>
        <td class="mono">${r.avgAutoFuel.toFixed(2)}</td>
        <td class="mono">${r.avgTower.toFixed(2)}</td>
      </tr>`).join('')
    : '<tr><td colspan="9">No rankings available for this event yet.</td></tr>';
}

// ---------- Init / wiring ----------

async function loadAllData() {
  const settings = getSettings();
  rawData = await fetchScoutingData(settings.apiUrl, getPassword());
  populateTeamSelect();
  renderCompareChart();
}

window.addEventListener('DOMContentLoaded', () => {
  const settings = getSettings();
  document.getElementById('apiUrlLoginInput').value = settings.apiUrl || '';

  // ----- Login -----
  document.getElementById('loginBtn').addEventListener('click', async () => {
    const apiUrl = document.getElementById('apiUrlLoginInput').value.trim();
    const password = document.getElementById('passwordInput').value;
    const errorEl = document.getElementById('loginError');
    errorEl.textContent = '';

    if (!apiUrl) { errorEl.textContent = 'Apps Script URL is required.'; return; }

    try {
      saveSettings({ ...getSettings(), apiUrl });
      rawData = await fetchScoutingData(apiUrl, password);
      sessionStorage.setItem(SESSION_PW_KEY, password);
      document.getElementById('loginScreen').style.display = 'none';
      document.getElementById('appShell').classList.add('show');
      populateTeamSelect();
      renderCompareChart();
    } catch (err) {
      errorEl.textContent = 'Incorrect password or unreachable URL.';
    }
  });

  // ----- Tabs -----
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
    });
  });

  // ----- Compare Teams -----
  document.getElementById('graphSelect').addEventListener('change', renderCompareChart);
  document.getElementById('detailsToggleBtn').addEventListener('click', () => {
    showCompareDetails = !showCompareDetails;
    document.getElementById('detailsToggleBtn').textContent = 'Show Details: ' + (showCompareDetails ? 'ON' : 'OFF');
    renderCompareChart();
  });

  // ----- Team Detail -----
  document.getElementById('teamSelect').addEventListener('change', (e) => {
    if (e.target.value) renderTeamDetail(e.target.value);
    else {
      document.getElementById('teamDetailContent').style.display = 'none';
      document.getElementById('teamDetailEmpty').style.display = 'block';
    }
  });

  // ----- Event Rankings -----
  document.getElementById('loadEventsBtn').addEventListener('click', async () => {
    const year = document.getElementById('tbaYear').value.trim();
    if (!year) return;
    try {
      await loadEventsForYear(year);
    } catch (err) {
      alert(err.message);
    }
  });
  document.getElementById('eventSearchInput').addEventListener('input', (e) => {
    renderEventResults(e.target.value);
  });
  document.querySelectorAll('#rankingsTable th.sortable').forEach((th) => {
    th.addEventListener('click', () => {
      if (sortState.key === th.dataset.key) {
        sortState.dir = sortState.dir === 'asc' ? 'desc' : 'asc';
      } else {
        sortState = { key: th.dataset.key, dir: 'asc' };
      }
      renderRankingsTable();
    });
  });

  // ----- Refresh -----
  document.getElementById('refreshBtn').addEventListener('click', async () => {
    try {
      await loadAllData();
    } catch (err) {
      alert('Failed to refresh: ' + err.message);
    }
  });

  // ----- Settings modal -----
  const modal = document.getElementById('settingsModal');
  document.getElementById('settingsBtn').addEventListener('click', () => {
    const s = getSettings();
    document.getElementById('apiUrlInput').value = s.apiUrl || '';
    document.getElementById('tbaKeyInput').value = s.tbaKey || '';
    modal.style.display = 'flex';
  });
  document.getElementById('settingsCancel').addEventListener('click', () => {
    modal.style.display = 'none';
  });
  document.getElementById('settingsSave').addEventListener('click', () => {
    saveSettings({
      apiUrl: document.getElementById('apiUrlInput').value.trim(),
      tbaKey: document.getElementById('tbaKeyInput').value.trim()
    });
    modal.style.display = 'none';
  });
});
