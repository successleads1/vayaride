(function () {
  const MAPBOX_TOKEN = 'pk.eyJ1IjoibWJ1c2lzZW5pIiwiYSI6ImNseTF3ZjZ0ajB6anUyanMyc3RmNzByem0ifQ.PCctEHWWSdY7rr0RTe28Xg';
  const qs = new URLSearchParams(location.search);
  const rideId = qs.get('rideId') || '';
  const viewAs = (qs.get('as') || '').toLowerCase(); // 'driver' | 'rider' | ''
  const driverChatIdParam = Number(qs.get('driverChatId') || NaN);

  if (!rideId) {
    const st = document.getElementById('statusText');
    if (st) st.textContent = 'Missing ride ID';
    throw new Error('Missing rideId');
  }

  // Header status visible only for driver
  const $statusBar = document.querySelector('header .status');
  if ($statusBar) $statusBar.style.display = (viewAs === 'driver') ? 'flex' : 'none';

  // Cache DOM
  const $statusText = document.getElementById('statusText');
  const $statusDot = document.getElementById('statusDot');
  const $chip = document.getElementById('followChip');
  const $gpsChip = document.getElementById('gpsChip');
  const $legend = document.getElementById('legend');
  const $arriveModal = document.getElementById('arriveModal');
  const $btnCloseModal = document.getElementById('btnCloseModal');
  const $btnNotifyRider = document.getElementById('btnNotifyRider');
  const $cancelModal = document.getElementById('cancelModal');
  const $btnCancel = document.getElementById('btnCancel');
  const $btnCancelClose = document.getElementById('btnCancelClose');
  const $btnCancelSend = document.getElementById('btnCancelSend');
  const $btnStart = document.getElementById('btnStart');
  const $btnPicked = document.getElementById('btnPicked');
  const $btnVoice = document.getElementById('btnVoice');
  const $btnFollow = document.getElementById('btnFollow');
  const $btnRecenter = document.getElementById('btnRecenter');
  const $bottomCta = document.getElementById('bottomCta');
  const $btnFinish = document.getElementById('btnFinish');
  const $finishModal = document.getElementById('finishModal');
  const $btnFinishClose = document.getElementById('btnFinishClose');
  const $btnFinishCash = document.getElementById('btnFinishCash');
  const $btnFinishPaid = document.getElementById('btnFinishPaid');
  const $btnBackTelegram = document.getElementById('btnBackTelegram');
  const $btnWaze = document.getElementById('btnWaze');
  const $summary = document.getElementById('summaryModal');
  const $sumAmount = document.getElementById('sumAmount');
  const $sumDistance = document.getElementById('sumDistance');
  const $sumPayment = document.getElementById('sumPayment');
  const $sumSub = document.getElementById('sumSub');
  const $btnSummaryClose = document.getElementById('btnSummaryClose');
  const $btnSummaryBack = document.getElementById('btnSummaryBack');
  const $ringtone = document.getElementById('ringtone');
  const $closeScreen = document.getElementById('closeScreen');
  const $btnHardClose = document.getElementById('btnHardClose');

  // Big Start Panel
  const $startPanel = document.getElementById('startPanel');
  const $btnStartBig = document.getElementById('btnStartBig');
  const $startPanelRideId = document.getElementById('startPanelRideId');
  if ($startPanelRideId) $startPanelRideId.textContent = rideId;

  /* =======================
   * Persistence
   * ======================= */
  const STORAGE_KEY = `vaya:trip:${rideId}`;
  const persist = (patch = {}) => {
    try {
      const cur = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      const next = { ...cur, ...patch, _t: Date.now(), _v: 1 };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {}
  };
  const restore = () => { try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); } catch { return {}; } };
  const clearPersist = () => { try { localStorage.removeItem(STORAGE_KEY); } catch {} };

  /* =======================
   * Helpers
   * ======================= */
  function smartClose() {
    try { if (window.Telegram?.WebApp?.close) { window.Telegram.WebApp.close(); return; } } catch {}
    try { window.close(); } catch {}
    try { window.open('', '_self'); window.close(); } catch {}
    if ($closeScreen) {
      $closeScreen.style.display = 'flex';
      if ($btnHardClose) $btnHardClose.onclick = () => {
        try { if (window.Telegram?.WebApp?.close) { window.Telegram.WebApp.close(); return; } } catch {}
        try { window.close(); } catch {}
        try { window.open('', '_self'); window.close(); } catch {}
        location.replace('about:blank');
      };
    } else {
      location.replace('about:blank');
    }
  }

  function keepScreenAlive() {
    setTimeout(() => {
      localStorage.setItem("keepScreenActive", "true");
      window.dispatchEvent(new Event('storage'));
      keepScreenAlive();
    }, 60000);
  }
  keepScreenAlive();

  function gotoTelegram(botUsername) {
    const tgUrl = `tg://resolve?domain=${botUsername}`;
    const webUrl = `https://t.me/${botUsername}`;
    const ua = navigator.userAgent || '';
    const isAndroid = /Android/i.test(ua);
    const isSamsung = /SamsungBrowser/i.test(ua);
    const intent =
      `intent://resolve?domain=${botUsername}` +
      `#Intent;scheme=tg;package=org.telegram.messenger;S.browser_fallback_url=${encodeURIComponent(webUrl)};end`;

    let triedIntent = false;
    const timer = setTimeout(() => {
      if (document.visibilityState !== 'hidden') {
        if (isAndroid && !triedIntent && !isSamsung) {
          triedIntent = true;
          try { window.location.href = intent; return; } catch {}
        }
        window.location.replace(webUrl);
      }
    }, 700);

    try { window.location.assign(tgUrl); }
    catch {
      clearTimeout(timer);
      if (isAndroid && !isSamsung) {
        try { window.location.href = intent; return; } catch {}
      }
      window.location.replace(webUrl);
    }
  }

  const BOT_USER_RIDER  = 'Vaya_rider';
  const BOT_USER_DRIVER = 'DriversOf-vayaride_bot';

  if ($btnBackTelegram) {
    $btnBackTelegram.addEventListener('click', (e) => {
      e.preventDefault();
      const bot = viewAs === 'driver' ? BOT_USER_DRIVER : BOT_USER_RIDER;
      gotoTelegram(bot);
    });
  }
  if ($btnSummaryBack) {
    $btnSummaryBack.onclick = (e) => {
      e.preventDefault();
      const bot = viewAs === 'driver' ? BOT_USER_DRIVER : BOT_USER_RIDER;
      gotoTelegram(bot);
    };
  }
  if ($btnSummaryClose) $btnSummaryClose.onclick = () => { $summary.style.display = 'none'; };

  const DEFAULT_RATE_TABLE = {
    normal:  { baseFare: 0, perKm: 7,  minCharge: 30, withinKm: 30 },
    comfort: { baseFare: 0, perKm: 8,  minCharge: 30, withinKm: 30 },
    luxury:  { baseFare: 0, perKm: 12, minCharge: 45, withinKm: 45 },
    xl:      { baseFare: 0, perKm: 10, minCharge: 39, withinKm: 40 },
  };
  const vehicleTypeGuess = 'normal';
  function priceWithRate(distanceKm, rate) {
    const within = rate.withinKm ?? 0;
    const variable = distanceKm <= within ? 0 : (rate.perKm ?? 0) * (distanceKm - within);
    return Math.round((rate.baseFare ?? 0) + (rate.minCharge ?? 0) + variable);
  }
  function computeEstimate(distanceKm) {
    const vt = vehicleTypeGuess in DEFAULT_RATE_TABLE ? vehicleTypeGuess : 'normal';
    return priceWithRate(Math.max(0, Number(distanceKm || 0)), DEFAULT_RATE_TABLE[vt]);
  }

  // Status (driver only)
  const STATUS = {
    IDLE:        { text: "Driver hasn’t started yet.", dot: '#777',    glow: '#777' },
    TO_PICKUP:   { text: 'En route to pickup…',        dot: '#00b3ff', glow: '#00b3ff' },
    ARRIVING:    { text: 'Driver is arriving at pickup…', dot: '#41e38a', glow: '#41e38a' },
    ARRIVED:     { text: 'Driver has arrived at pickup.', dot: '#00e676', glow: '#0f0' },
    PICKED:      { text: 'Picked up. Heading to dropoff…', dot: '#ffb84d', glow: '#ffb84d' },
    TO_DROPOFF:  { text: 'Heading to dropoff…',        dot: '#ffb84d', glow: '#ffb84d' },
    AT_DROPOFF:  { text: 'Arrived at dropoff.',        dot: '#a78bfa', glow: '#a78bfa' },
    COMPLETED:   { text: '✅ Trip completed.',         dot: '#00e676', glow: '#0f0' },
    CANCELLED:   { text: '❌ Trip cancelled.',         dot: '#ff4d4d', glow: '#ff4d4d' },
    LOADING:     { text: 'Loading trip…',              dot: '#777',    glow: '#777' },
    WAITING:     { text: 'Waiting for driver…',        dot: '#777',    glow: '#777' },
    ERROR:       { text: 'Something went wrong.',      dot: '#ff4d4d', glow: '#ff4d4d' },
  };
  function setStatus(kind, extraText){
    if (viewAs !== 'driver') return;
    const s = STATUS[kind] || STATUS.ERROR;
    if ($statusText) $statusText.textContent = extraText ? extraText : s.text;
    if ($statusDot) {
      $statusDot.style.background = s.dot;
      $statusDot.style.boxShadow  = `0 0 8px ${s.glow}`;
    }
  }

  const speak = (text) => {
    if (viewAs !== 'driver') return;
    try {
      const u = new SpeechSynthesisUtterance(text);
      const pick = (speechSynthesis.getVoices() || []).find((v) => /en(-|_)ZA/i.test(v.lang));
      if (pick) u.voice = pick;
      u.rate = 1.05;
      speechSynthesis.cancel();
      speechSynthesis.speak(u);
    } catch {}
  };

  /* =======================
   * Map + Icons
   * ======================= */
  const map = L.map('map', {
    zoomControl: true,
    attributionControl: true,
    touchZoom: true,
    tap: true,
    wheelDebounceTime: 50,
  });
  const baseLayer = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    subdomains: 'abcd',
    maxZoom: 20,
    attribution: '&copy; CARTO | &copy; OpenStreetMap',
  }).addTo(map);
  requestAnimationFrame(() => map.invalidateSize());

  const driverPulseIcon = L.divIcon({ className: 'pulse', iconSize: [42, 42], iconAnchor: [21, 21] });
  const driverArrowIcon = (deg = 0) =>
    L.divIcon({
      className: 'driver-arrow',
      html: `<svg viewBox="0 0 24 24" style="transform:rotate(${deg}deg)"><path d="M12 2 L17 14 L12 11 L7 14 Z" fill="#fff"></path></svg>`,
      iconSize: [26, 26],
      iconAnchor: [13, 13],
    });
  const label = (text) => L.marker([0, 0], { icon: L.divIcon({ className: 'lbl', html: text, iconAnchor: [-6, 20] }) });

  function makePoleIcon({ hex, rgb, kind, etaText }) {
    const dropCls = kind === 'drop' ? 'drop' : '';
    const html = `<div class="poi ${dropCls}" style="--poi:${hex};--poi-rgb:${rgb}">
      <span class="head"><span class="txt">${etaText || ''}</span></span>
      <span class="stick"></span>
      <span class="base"></span>
    </div>`;
    return L.divIcon({ className: 'poi-icon', html, iconSize: [32, 92], iconAnchor: [16, 84] });
  }
  function setPoleETA(marker, text) {
    if (!marker) return;
    const el = marker.getElement();
    if (!el) {
      const opts = marker.options._poleOpts;
      marker.setIcon(makePoleIcon({ ...opts, etaText: text }));
      return;
    }
    const t = el.querySelector('.head .txt');
    if (t) t.textContent = text || '';
  }

  // math helpers
  const toRad = (x) => (x * Math.PI) / 180;
  const metersBetween = (a, b) => {
    const R = 6371000, dLat = toRad(b.lat - a.lat), dLon = toRad(b.lng - a.lng);
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  };
  const fmtKm = (km) => km.toFixed(2) + ' km';
  const routeParams = 'geometries=geojson&alternatives=false&overview=full&steps=false&continue_straight=true';
  function fmtETAminOrSec(sec) {
    if (sec == null || !isFinite(sec)) return '';
    const m = Math.max(0, Math.round(sec / 60));
    if (m >= 1) return `${m} min`;
    const s = Math.max(5, Math.round(sec / 5) * 5);
    return `${s}s`;
  }
  function fmtArriveClock(sec) {
    const d = new Date(Date.now() + Math.max(0, Math.round(sec)) * 1000);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  function bearingDeg(a, b) {
    const φ1 = toRad(a.lat), φ2 = toRad(b.lat), Δλ = toRad(b.lng - a.lng);
    const y = Math.sin(Δλ) * Math.cos(φ2);
    const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
    return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  }

  /* =======================
   * Live state
   * ======================= */
  let routeDistanceKm = 0;
  let pickup, dropoff, driverChatId = null;
  let pickupLabel, dropLabel, pickupPoleMarker = null, dropPoleMarker = null, legTrip = null;

  let driverMarker = null, driverArrow = null, driverPos = null, lastDriverForBearing = null, lastBearing = 0;

  let socket;
  let driverGuideLine = null;
  let guideFetchInFlight = false;
  let lastGuideKey = null;
  let lastGuideMs = 0;
  let autoFollow = false;
  let arrivedShown = false;
  let pickedUp = false;
  let started = false;
  let cancelled = false;
  let finished = false;

  let etaToPickupSec = null;
  let etaToDropoffSec = null;
  let etaStampMs = null;

  const ARRIVE_M = 35;             // distance within which "Pickup" activates
  const COMPLETE_ENABLE_M = 60;
  const COMPLETE_HARD_M = 120;

  /* =======================
   * Restore persisted state ASAP
   * ======================= */
  const bootPersist = restore();

  // driver-only controls
  if (viewAs === 'driver') {
    if ($bottomCta) $bottomCta.style.display = 'block';
    if (Number.isFinite(driverChatIdParam) && $gpsChip) $gpsChip.style.display = 'block';
  } else {
    if ($btnStart) $btnStart.style.display = 'none';
    if ($btnPicked) $btnPicked.style.display = 'none';
    const leftRail = document.getElementById('leftRail');
    if (leftRail) leftRail.style.display = 'block';
    if ($bottomCta) $bottomCta.style.display = 'none';
    if ($gpsChip) $gpsChip.style.display = 'none';
  }

  /* =======================
   * Terminal (expired etc.)
   * ======================= */
  function renderExpiredScreen(info = {}) {
    try { speechSynthesis.cancel(); } catch {}
    try { socket?.disconnect(); } catch {}
    if (typeof gpsWatchId === 'number') {
      try { navigator.geolocation.clearWatch(gpsWatchId); } catch {}
      gpsWatchId = null;
    }

    disableAllControls();
    const leftRail = document.getElementById('leftRail');
    if (leftRail) leftRail.style.display = 'none';
    const sidepanel = document.querySelector('.sidepanel');
    if (sidepanel) sidepanel.style.display = 'none';
    if ($legend) $legend.style.display = 'none';
    if ($statusBar) $statusBar.style.display = 'none';
    if ($arriveModal) $arriveModal.style.display = 'none';
    if ($finishModal) $finishModal.style.display = 'none';
    if ($summary) $summary.style.display = 'none';

    const reason = (info.reason || info.status || '').toString().toLowerCase();
    let titleText = "This link doesn’t exist anymore";
    if (reason === 'cancelled')  titleText = 'Trip cancelled';
    if (reason === 'completed' || reason === 'finished') titleText = 'Trip completed';

    if ($closeScreen) {
      const title = $closeScreen.querySelector('.end-card h2');
      const para  = $closeScreen.querySelector('.end-card p');
      if (title) title.textContent = titleText;
      if (para)  para.textContent  = 'This tracking page has expired. You can safely close this tab.';
      $closeScreen.style.display = 'flex';
      if ($btnHardClose) $btnHardClose.onclick = () => smartClose();
    }

    const mapEl = document.getElementById('map');
    if (mapEl) {
      mapEl.style.filter = 'grayscale(100%) brightness(0.6)';
      mapEl.style.pointerEvents = 'none';
    }
  }

  /* =======================
   * Load trip basics
   * ======================= */
  setStatus('LOADING');

  fetch(`/api/ride/${encodeURIComponent(rideId)}`)
    .then(async (r) => {
      let data = null;
      try { data = await r.json(); } catch {}
      if (!r.ok) {
        if (r.status === 410 || r.status === 404 || data?.error === 'expired') {
          renderExpiredScreen(data || {});
          throw new Error('Link expired');
        }
        throw new Error(data?.error || 'Load failed');
      }
      if (data?.error === 'expired') {
        renderExpiredScreen(data || {});
        throw new Error('Link expired');
      }
      return data;
    })
    .then(async (data) => {
      pickup = data.pickup;
      dropoff = data.destination;
      driverChatId = data.driverChatId || bootPersist.driverChatId || null;

      label('Pickup').setLatLng([pickup.lat, pickup.lng]).addTo(map);
      label('Dropoff').setLatLng([dropoff.lat, dropoff.lng]).addTo(map);

      const pickIcon = makePoleIcon({ hex: '#41e38a', rgb: '65,227,138', kind: 'pick', etaText: 'Pickup' });
      const dropIcon = makePoleIcon({ hex: '#ffb84d', rgb: '255,184,77', kind: 'drop', etaText: 'Arrive at —' });

      pickupPoleMarker = L.marker([pickup.lat, pickup.lng], { icon: pickIcon }).addTo(map);
      pickupPoleMarker.options._poleOpts = { hex: '#41e38a', rgb: '65,227,138', kind: 'pick' };

      dropPoleMarker = L.marker([dropoff.lat, dropoff.lng], { icon: dropIcon }).addTo(map);
      dropPoleMarker.options._poleOpts = { hex: '#ffb84d', rgb: '255,184,77', kind: 'drop' };

      try {
        const url = `https://api.mapbox.com/directions/v5/mapbox/driving/${pickup.lng},${pickup.lat};${dropoff.lng},${dropoff.lat}?${routeParams}&access_token=${MAPBOX_TOKEN}`;
        const res = await fetch(url);
        const json = await res.json();
        if (json.routes && json.routes[0]) {
          const latlngs = json.routes[0].geometry.coordinates.map(([lng, lat]) => [lat, lng]);
          legTrip = L.polyline(latlngs, { color: '#00c2ff', weight: 12, opacity: 1 }).addTo(map);
          routeDistanceKm = (json.routes[0].distance || 0) / 1000;
        } else {
          throw new Error('No routes');
        }
      } catch {
        legTrip = L.polyline(
          [[pickup.lat, pickup.lng],[dropoff.lat, dropoff.lng]],
          { color: '#00c2ff', weight: 12, opacity: 1 }
        ).addTo(map);
        routeDistanceKm = metersBetween(pickup, dropoff) / 1000;
      }

      map.fitBounds(L.latLngBounds([[pickup.lat, pickup.lng],[dropoff.lat, dropoff.lng]]).pad(0.25));
      if (map.getZoom() < 15) map.setZoom(15);
      map.invalidateSize();

      restoreLiveUI();

      setStatus('WAITING');
      wireSockets();
      if (driverChatId) {
        persist({ driverChatId });
        primeLast();
      }
      updateWazeLink();

      // Show big Start panel immediately for driver (if not started yet)
      if (viewAs === 'driver' && !bootPersist.started) {
        $startPanel.style.display = 'flex';
        $startPanel.setAttribute('aria-hidden', 'false');
      }

      if (viewAs === 'driver' && Number.isFinite(driverChatIdParam)) {
        startDeviceGpsStreaming(driverChatIdParam);
      }
    })
    .catch((e) => {
      if (String(e.message) === 'Link expired') return;
      setStatus('ERROR', 'Failed to load trip.');
      console.error(e);
    });

  /* =======================
   * Restore UI
   * ======================= */
  function restoreLiveUI() {
    started      = !!bootPersist.started;
    pickedUp     = !!bootPersist.pickedUp;
    arrivedShown = !!bootPersist.arrivedShown;
    finished     = !!bootPersist.finished;
    cancelled    = !!bootPersist.cancelled;

    if (bootPersist.driverPos &&
        typeof bootPersist.driverPos.lat === 'number' &&
        typeof bootPersist.driverPos.lng === 'number') {
      driverPos = { ...bootPersist.driverPos };
      lastDriverForBearing = { ...driverPos };
      ensureDriverMarkers();
      if (driverMarker) driverMarker.setLatLng([driverPos.lat, driverPos.lng]);
      if (driverArrow)  driverArrow.setLatLng([driverPos.lat, driverPos.lng]);
    }

    etaToPickupSec  = Number.isFinite(bootPersist.etaToPickupSec) ? bootPersist.etaToPickupSec : null;
    etaToDropoffSec = Number.isFinite(bootPersist.etaToDropoffSec) ? bootPersist.etaToDropoffSec : null;
    etaStampMs      = Number.isFinite(bootPersist.etaStampMs) ? bootPersist.etaStampMs : null;

    if (etaStampMs) {
      const drift = (Date.now() - etaStampMs) / 1000;
      if (etaToPickupSec != null)  setPoleETA(pickupPoleMarker, fmtETAminOrSec(Math.max(0, etaToPickupSec - drift)));
      if (etaToDropoffSec != null) setPoleETA(dropPoleMarker, `Arrive at ${fmtArriveClock(Math.max(0, etaToDropoffSec - drift))}`);
    }

    updateDriverGuideRoad(true);
    updateFinishUI();
  }

  /* =======================
   * Sockets
   * ======================= */
  function wireSockets() {
    if (typeof io !== 'function') return;
    socket = io({ transports: ['websocket', 'polling'] });
    socket.io.on('reconnect', () => { bindChannels(); });
    bindChannels();
  }

  function bindChannels() {
    if (!socket) return;

    socket.off(`ride:${rideId}:driverLocation`);
    socket.on(`ride:${rideId}:driverLocation`, (loc) => onDriverLocation(loc));

    socket.off(`ride:${rideId}:arrived`);
    socket.on(`ride:${rideId}:arrived`, () => handleArrival());

    socket.off(`ride:${rideId}:started`);
    socket.on(`ride:${rideId}:started`, () => {
      started = true;
      persist({ started: true });
      setStatus('TO_PICKUP');
      hideStartPanel();
    });

    socket.off(`ride:${rideId}:picked`);
    socket.on(`ride:${rideId}:picked`, () => {
      pickedUp = true;
      persist({ pickedUp: true });
      setStatus('PICKED');
      updateFinishUI();
      updateWazeLink();
    });

    socket.off(`ride:${rideId}:cancelled`);
    socket.on(`ride:${rideId}:cancelled`, () => {
      cancelled = true;
      persist({ cancelled: true });
      teardownAndClose('The other party cancelled the trip.');
    });

    socket.off(`ride:${rideId}:finished`);
    socket.on(`ride:${rideId}:finished`, (payload = {}) => {
      onFinishedUI({
        paidMethod: payload.paidMethod || 'app',
        amount: Number(payload.amount),
        distanceKm: Number(payload.distanceKm),
        fromServer: true,
      });
    });
  }

  async function primeLast() {
    try {
      const r = await fetch(`/api/driver-last-loc/${encodeURIComponent(driverChatId)}?rideId=${encodeURIComponent(rideId)}`);
      if (!r.ok) return;
      const loc = await r.json();
      if (typeof loc.lat === 'number' && typeof loc.lng === 'number') onDriverLocation(loc, true);
    } catch {}
    setTimeout(() => { if (!driverMarker) primeLast(); }, 3000);
  }

  function ensureDriverMarkers() {
    if (!driverMarker && driverPos) {
      driverMarker = L.marker([driverPos.lat, driverPos.lng], { icon: driverPulseIcon, interactive: false }).addTo(map);
      driverArrow  = L.marker([driverPos.lat, driverPos.lng], { icon: driverArrowIcon(lastBearing), interactive: false, zIndexOffset: 1000 }).addTo(map);
    }
  }

  function tweenMarker(marker, from, to, ms = 600) {
    const start = performance.now();
    function step(ts) {
      const t = Math.min(1, (ts - start) / ms);
      const lat = from.lat + (to.lat - from.lat) * t;
      const lng = from.lng + (to.lng - from.lng) * t;
      marker.setLatLng([lat, lng]);
      if (t < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  function onDriverLocation(loc) {
    if (!loc || typeof loc.lat !== 'number' || typeof loc.lng !== 'number') return;

    if (!driverMarker || !driverPos) {
      driverPos = { lat: loc.lat, lng: loc.lng };
      lastDriverForBearing = { ...driverPos };
      ensureDriverMarkers();
      updateDriverGuideRoad(true);
      if (!started && !pickedUp && !arrivedShown) {
        setStatus('IDLE', viewAs === 'driver' ? 'Tap Start to begin navigation to the pickup.' : undefined);
        // make sure the big Start panel is visible for drivers
        if (viewAs === 'driver' && !started) showStartPanel();
      }
      maybeDetectArrival();
      maybeDetectDropoff();
      updateApproachStatus();
      updateFinishUI();
    } else {
      const from = { ...driverPos };
      const to   = { lat: loc.lat, lng: loc.lng };
      const movedMeters = metersBetween(from, to);
      driverPos = to;
      tweenMarker(driverMarker, from, to, 500);
      tweenMarker(driverArrow, from, to, 500);
      if (movedMeters > 1) {
        const br = bearingDeg(lastDriverForBearing, to);
        lastBearing = br;
        const el = driverArrow.getElement();
        if (el) el.querySelector('svg').style.transform = `rotate(${br}deg)`;
        lastDriverForBearing = to;
        if (autoFollow) map.setView([to.lat, to.lng], Math.max(map.getZoom(), 19), { animate: true });
      }
      if (movedMeters > 5) updateDriverGuideRoad(false);
      if (autoFollow && movedMeters > 0.5 && $chip) $chip.style.display = 'block';
      maybeDetectArrival();
      maybeDetectDropoff();
      updateApproachStatus();
      updateFinishUI();
    }

    persist({ driverPos });
  }

  function maybeDetectArrival() {
    if (!driverPos || !pickup || arrivedShown || pickedUp) return;
    const dMeters = metersBetween(driverPos, pickup);
    // Enable "Picked" ONLY when within ARRIVE_M
    if ($btnPicked) $btnPicked.disabled = dMeters > ARRIVE_M;
    if (dMeters <= ARRIVE_M) handleArrival();
  }

  function maybeDetectDropoff() {
    if (!driverPos || !dropoff || !pickedUp || cancelled || finished) return;
    const dMeters = metersBetween(driverPos, dropoff);
    if (dMeters <= 20)      setStatus('AT_DROPOFF', 'Arrived at dropoff.');
    else if (dMeters <= 200)setStatus('TO_DROPOFF', 'Almost there…');
    else                    setStatus('TO_DROPOFF');
    updateFinishUI();
  }

  function handleArrival() {
    if (arrivedShown || pickedUp) return;
    arrivedShown = true;
    persist({ arrivedShown: true });
    speak(viewAs === 'driver' ? 'You have arrived at the pickup point.' : undefined);
    if (viewAs === 'driver' && $arriveModal) $arriveModal.style.display = 'flex';
    if (legTrip) legTrip.setStyle({ weight: 14, opacity: 1 });
    setStatus('ARRIVED');
    // at arrival, allow "Picked"
    if ($btnPicked) $btnPicked.disabled = false;
  }

  async function updateDriverGuideRoad(force = false) {
    if (!driverPos || !pickup || !dropoff) return;
    const target = pickedUp ? dropoff : pickup;
    const color  = pickedUp ? '#ffb84d' : '#41e38a';
    const key = `${pickedUp ? 'drop' : 'pick'}:${driverPos.lat.toFixed(4)},${driverPos.lng.toFixed(4)}->${target.lat.toFixed(4)},${target.lng.toFixed(4)}`;
    const now = Date.now();
    if (!force && (guideFetchInFlight || (key === lastGuideKey && now - lastGuideMs < 1500))) return;

    guideFetchInFlight = true;
    try {
      const url = `https://api.mapbox.com/directions/v5/mapbox/driving/${driverPos.lng},${driverPos.lat};${target.lng},${target.lat}?${routeParams}&access_token=${MAPBOX_TOKEN}`;
      const res = await fetch(url);
      const data = await res.json();
      let latlngs = null;
      let durationSec = null;

      if (data?.routes?.[0]?.geometry?.coordinates) {
        latlngs = data.routes[0].geometry.coordinates.map(([lng, lat]) => [lat, lng]);
        durationSec = Number(data.routes[0].duration) || null;
      }
      if (!latlngs?.length) latlngs = [[driverPos.lat, driverPos.lng],[target.lat, target.lng]];

      if (!driverGuideLine) {
        driverGuideLine = L.polyline(latlngs, { color, weight: 6, opacity: 0.95, dashArray: '8,10' }).addTo(map);
      } else {
        driverGuideLine.setLatLngs(latlngs);
        driverGuideLine.setStyle({ color, weight: 6, opacity: 0.95, dashArray: '8,10' });
      }

      if (durationSec == null) {
        const distM = metersBetween(driverPos, target);
        durationSec = (distM / 1000 / 30) * 3600;
      }

      if (!pickedUp) {
        etaToPickupSec = durationSec;
        setPoleETA(pickupPoleMarker, fmtETAminOrSec(etaToPickupSec));
      } else {
        etaToDropoffSec = durationSec;
        setPoleETA(dropPoleMarker, `Arrive at ${fmtArriveClock(etaToDropoffSec)}`);
      }
      etaStampMs = Date.now();
      persist({ etaToPickupSec, etaToDropoffSec, etaStampMs });

      lastGuideKey = key;
      lastGuideMs  = now;
    } catch {
      const latlngs = [[driverPos.lat, driverPos.lng],[target.lat, target.lng]];
      if (!driverGuideLine) {
        driverGuideLine = L.polyline(latlngs, { color, weight: 5, opacity: 0.9, dashArray: '6,8' }).addTo(map);
      } else {
        driverGuideLine.setLatLngs(latlngs);
        driverGuideLine.setStyle({ color, weight: 5, opacity: 0.9, dashArray: '6,8' });
      }
      const distM = metersBetween(driverPos, target);
      const durationSec = (distM / 1000 / 30) * 3600;

      if (!pickedUp) {
        etaToPickupSec = durationSec;
        setPoleETA(pickupPoleMarker, fmtETAminOrSec(etaToPickupSec));
      } else {
        etaToDropoffSec = durationSec;
        setPoleETA(dropPoleMarker, `Arrive at ${fmtArriveClock(etaToDropoffSec)}`);
      }
      etaStampMs = Date.now();
      persist({ etaToPickupSec, etaToDropoffSec, etaStampMs });
    } finally {
      guideFetchInFlight = false;
    }
  }

  function updateApproachStatus() {
    if (cancelled || finished) return;
    if (pickedUp) { setStatus('TO_DROPOFF'); return; }
    if (!driverPos || !pickup) return;

    // Always enforce Pickup button state while approaching
    const dMeters = metersBetween(driverPos, pickup);
    if ($btnPicked) $btnPicked.disabled = dMeters > ARRIVE_M;

    if (!started) {
      setStatus('IDLE', viewAs === 'driver' ? 'Tap Start to begin navigation to the pickup.' : undefined);
      return;
    }
    if (dMeters <= ARRIVE_M) { setStatus('ARRIVING'); return; }
    const km = dMeters / 1000;
    const txt = km > 0.2 ? `He’s coming! Driver is ~ ${fmtKm(km)} from pickup.` : undefined;
    setStatus('TO_PICKUP', txt);
  }

  function updateFinishUI() {
    if (viewAs !== 'driver') return;
    if (cancelled || finished) { $btnFinish.disabled = true; return; }
    if (!pickedUp || !driverPos || !dropoff) { $btnFinish.disabled = true; return; }
    const dMeters = metersBetween(driverPos, dropoff);
    $btnFinish.disabled = dMeters > COMPLETE_ENABLE_M;
  }

  function updateWazeLink() {
    if (!$btnWaze || !pickup || !dropoff) return;
    const target = pickedUp ? dropoff : pickup;
    const url = `https://www.waze.com/ul?ll=${encodeURIComponent(target.lat)},${encodeURIComponent(target.lng)}&navigate=yes`;
    $btnWaze.href = url;
  }

  // UI actions (driver)
  if ($btnCloseModal) $btnCloseModal.onclick = () => ($arriveModal.style.display = 'none');
  if ($btnNotifyRider) $btnNotifyRider.onclick = () => {
    $arriveModal.style.display = 'none';
    speak('Notifying rider that you are outside.');
  };

  function showStartPanel() {
    if (viewAs !== 'driver' || started) return;
    $startPanel.style.display = 'flex';
    $startPanel.setAttribute('aria-hidden', 'false');
  }
  function hideStartPanel() {
    $startPanel.style.display = 'none';
    $startPanel.setAttribute('aria-hidden', 'true');
  }

  const doStart = async () => {
    if (viewAs !== 'driver') return;
    if (!driverPos) { setStatus('WAITING', 'Waiting for driver GPS…'); /* still allow start */ }
    started = true;
    persist({ started: true });
    setStatus('TO_PICKUP', 'Starting trip: heading to pickup…');
    hideStartPanel();
    try { await fetch(`/api/ride/${encodeURIComponent(rideId)}/start`, { method: 'POST' }); } catch {}
    updateDriverGuideRoad(true);
    updateWazeLink();
  };

  if ($btnStart)     $btnStart.onclick     = doStart;
  if ($btnStartBig)  $btnStartBig.onclick  = doStart;

  if ($btnPicked) {
    $btnPicked.onclick = async () => {
      if (viewAs !== 'driver' || $btnPicked.disabled) return;
      pickedUp = true;
      persist({ pickedUp: true });
      setStatus('PICKED');
      if (legTrip) legTrip.setStyle({ weight: 14, opacity: 1 });
      try { await fetch(`/api/ride/${encodeURIComponent(rideId)}/picked`, { method: 'POST' }); } catch {}
      updateDriverGuideRoad(true);
      updateFinishUI();
      updateWazeLink();
    };
  }

  if ($btnFinish) {
    $btnFinish.onclick = async () => {
      if (viewAs !== 'driver' || finished) return;
      if (driverPos && dropoff) {
        const dMeters = metersBetween(driverPos, dropoff);
        if (dMeters > COMPLETE_HARD_M) {
          const ok = confirm('You seem far from the dropoff. Finish the trip anyway?');
          if (!ok) return;
        }
      }
      $finishModal.style.display = 'flex';
    };
  }

  if ($btnFinishCash) {
    $btnFinishCash.onclick = async () => {
      try {
        const j = await postFinish('cash');
        $finishModal.style.display = 'none';
        onFinishedUI({ paidMethod: 'cash', amount: j?.amount, distanceKm: j?.distanceKm, fromServer: true });
      } catch {
        $finishModal.style.display = 'none';
        onFinishedUI({ paidMethod: 'cash', amount: computeEstimate(routeDistanceKm), distanceKm: routeDistanceKm, fromServer: false });
      }
    };
  }

  if ($btnFinishPaid) {
    $btnFinishPaid.onclick = async () => {
      try {
        const j = await postFinish('app');
        $finishModal.style.display = 'none';
        onFinishedUI({ paidMethod: 'app', amount: j?.amount, distanceKm: j?.distanceKm, fromServer: true });
      } catch {
        $finishModal.style.display = 'none';
        onFinishedUI({ paidMethod: 'app', amount: computeEstimate(routeDistanceKm), distanceKm: routeDistanceKm, fromServer: false });
      }
    };
  }

  if ($btnFinishClose) $btnFinishClose.onclick = () => ($finishModal.style.display = 'none');

  if ($btnCancel)      $btnCancel.onclick      = () => ($cancelModal.style.display = 'flex');
  if ($btnCancelClose) $btnCancelClose.onclick = () => ($cancelModal.style.display = 'none');
  if ($btnCancelSend)
    $btnCancelSend.onclick = async () => {
      const selected = document.querySelector('input[name="cxl"]:checked');
      const reason = selected ? selected.value : 'Other';
      const note = reason === 'Other' ? (document.getElementById('otherText').value || '').trim() : '';
      try {
        await fetch(`/api/ride/${encodeURIComponent(rideId)}/cancel`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason, note }),
        });
      } catch {}
      finally {
        $cancelModal.style.display = 'none';
        cancelled = true;
        persist({ cancelled: true });
        teardownAndClose('Trip cancelled.');
      }
    };

  if ($btnRecenter) {
    $btnRecenter.onclick = () => {
      if (!driverPos) return;
      autoFollow = true;
      updateFollowUI();
      map.setView([driverPos.lat, driverPos.lng], 19, { animate: true });
      if ($chip) $chip.style.display = 'block';
    };
  }

  function postFinish(paidMethod) {
    return fetch(`/api/ride/${encodeURIComponent(rideId)}/finish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paidMethod }),
    }).then(async (r) => {
      let j = null;
      try { j = await r.json(); } catch {}
      if (!r.ok) throw Object.assign(new Error('Finish failed'), { response: j });
      return j || {};
    });
  }

  function disableAllControls() {
    [
      'btnStart',
      'btnPicked',
      'btnVoice',
      'btnFollow',
      'btnRecenter',
      'btnCancel',
      'btnFinish',
      'btnBackTelegram',
      'btnBackWhatsapp',
      'btnWaze',
    ].forEach((id) => {
      const b = document.getElementById(id);
      if (b) {
        b.disabled = true;
        b.setAttribute('aria-disabled', 'true');
      }
    });
  }

  function teardownAndClose(message) {
    setStatus('CANCELLED', message || 'Trip cancelled.');
    disableAllControls();
    try { speechSynthesis.cancel(); } catch {}
    try { socket?.disconnect(); } catch {}
    map.eachLayer((l) => { if (l !== baseLayer) map.removeLayer(l); });
    if ($chip) $chip.style.display = 'none';
    if ($gpsChip) $gpsChip.style.display = 'none';
    if ($legend) $legend.style.display = 'none';
    if ($arriveModal)  $arriveModal.style.display = 'none';
    if ($finishModal)  $finishModal.style.display = 'none';
    if ($summary)      $summary.style.display = 'none';
    clearPersist();
    smartClose();
  }

  function showTripSummaryModal({ paidMethod, amount, distanceKm, fromServer }) {
    const amt  = Number.isFinite(amount) ? amount : computeEstimate(distanceKm || routeDistanceKm || 0);
    const dist = Number.isFinite(distanceKm) ? distanceKm : routeDistanceKm || 0;
    if ($sumAmount)   $sumAmount.textContent = 'R' + Math.round(amt);
    if ($sumDistance) $sumDistance.textContent = (dist > 0 ? dist.toFixed(2) : '0.00') + ' km';
    if ($sumPayment)  $sumPayment.textContent = paidMethod === 'cash' ? 'Cash' : 'Payfast / Card';
    if ($sumSub)      $sumSub.textContent = fromServer ? 'Final earnings' : 'Estimated earnings';
    try { $ringtone.currentTime = 0; $ringtone.play().catch(() => {}); } catch {}
    if ($summary) $summary.style.display = 'flex';
  }

  function onFinishedUI(payload) {
    finished = true;
    persist({ finished: true });
    const paidMethod = payload?.paidMethod || 'app';
    speak('Trip completed. Thank you.');
    setStatus('COMPLETED', '✅ Trip completed. A receipt will be sent shortly.');
    disableAllControls();
    if (viewAs === 'driver') {
      showTripSummaryModal({
        paidMethod,
        amount: payload?.amount,
        distanceKm: payload?.distanceKm,
        fromServer: !!payload?.fromServer,
      });
    }
    setTimeout(clearPersist, 1000 * 60 * 5);
  }

  function updateFollowUI() {
    const btn = document.getElementById('btnFollow');
    if (!btn) return;
    btn.setAttribute('aria-pressed', String(!!autoFollow));
    btn.title = btn.dataset.tip = autoFollow ? 'Follow: On' : 'Follow: Off';
    if (!autoFollow && $chip) $chip.style.display = 'none';
  }

  if ($btnFollow) {
    $btnFollow.onclick = () => {
      autoFollow = !autoFollow;
      if (autoFollow && driverPos) {
        map.setView([driverPos.lat, driverPos.lng], Math.max(map.getZoom(), 19), { animate: true });
        if ($chip) $chip.style.display = 'block';
      } else {
        if ($chip) $chip.style.display = 'none';
      }
      updateFollowUI();
    };
  }

  let gpsWatchId = null;
  function startDeviceGpsStreaming(driverChatId) {
    if (!socket) return;
    if (!navigator.geolocation) return;
    const opts = { enableHighAccuracy: true, maximumAge: 1000, timeout: 10000 };
    gpsWatchId = navigator.geolocation.watchPosition(
      (pos) => {
        const { latitude, longitude, accuracy, heading } = pos.coords || {};
        if (typeof latitude !== 'number' || typeof longitude !== 'number') return;
        socket.emit('driver:mapLocation', {
          rideId,
          chatId: Number(driverChatId),
          lat: latitude,
          lng: longitude,
          heading: typeof heading === 'number' && isFinite(heading) ? heading : null,
          src: 'html5',
          accuracy: Number(accuracy) || null,
        });
      },
      () => {},
      opts
    );
  }

  // cancel modal “other reason”
  const reasonList = document.getElementById('reasonList');
  if (reasonList) {
    reasonList.addEventListener('change', () => {
      const el = document.querySelector('input[name="cxl"]:checked');
      const otherWrap = document.getElementById('otherWrap');
      if (otherWrap) otherWrap.style.display = el && el.value === 'Other' ? 'block' : 'none';
    });
  }

  // Persist a heartbeat
  window.addEventListener('beforeunload', () => {
    persist({
      started,
      pickedUp,
      arrivedShown,
      finished,
      cancelled,
      driverPos,
      etaToPickupSec,
      etaToDropoffSec,
      etaStampMs,
      driverChatId,
    });
  });
})();
