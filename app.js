(function () {
        "use strict";

        // ---------- constants ----------
        var SWEEP_START = -120;          // degrees at 0 speed
        var SWEEP_END = 120;             // degrees at max speed
        var MAX = 120;                   // dial full-scale, km/h
        var MS_TO_KMH = 3.6;
        var STORAGE_KEY = "speedbus.tripRecords.v1";
        var ACTIVE_KEY = "speedbus.activeTrip.v1";
        var MAX_ACCURACY_M = 35;
        var MAX_SPEED_KMH = 130;

        // ---------- state ----------
        var tracking = false;
        var watchId = null;
        var wakeLock = null;

        var displayKmh = 0;   // smoothed speed shown by needle/readout
        var targetKmh = 0;    // latest measured speed
        var lastFix = null;   // last quality-checked position
        var recent = [];      // recent raw km/h samples for median smoothing

        var maxKmh = 0;
        var distM = 0;
        var brakeCount = 0;
        var lastBrakeAt = 0;
        var trip = null;
        var displayedTrip = null;
        var savedTrips = [];
        var timerId = null;
        var tripMapInstance = null;
        var tripMapTileLayer = null;
        var tripMapLayers = [];
        var speedLimitGrid = null;
        var speedLimitGridPromise = null;
        var SPEED_LIMIT_DATA_URL = "https://donnees.montreal.ca/fr/dataset/1ef0211f-8101-410c-9266-b1f2db360669/resource/579f1179-c7db-4453-adbb-0729db8d4764/download/limites_de_vitesses_20260226.zip";
        var MAP_TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";

        // ---------- elements ----------
        var dot = document.getElementById("dot");
        var statusText = document.getElementById("statusText");
        var accuracyEl = document.getElementById("accuracy");
        var bigSpeed = document.getElementById("bigSpeed");
        var bigUnit = document.getElementById("bigUnit");
        var needleGroup = document.getElementById("needleGroup");
        var ticksG = document.getElementById("ticks");
        var toggleBtn = document.getElementById("toggleBtn");
        var toggleBtnLabel = document.getElementById("toggleBtnLabel");
        var tripCommentInput = document.getElementById("tripComment");
        var addCommentBtn = document.getElementById("addCommentBtn");
        var commentList = document.getElementById("commentList");
        var msg = document.getElementById("msg");
        var statMax = document.getElementById("statMax");
        var statAvg = document.getElementById("statAvg");
        var statDist = document.getElementById("statDist");
        var statTime = document.getElementById("statTime");
        var statBrakes = document.getElementById("statBrakes");
        var statIdle = document.getElementById("statIdle");
        var tripHistory = document.getElementById("tripHistory");
        var mapPanel = document.getElementById("mapPanel");
        var tripMapEl = document.getElementById("tripMap");
        var mapStatus = document.getElementById("mapStatus");
        var busRouteInput = document.getElementById("busRoute");
        var busRouteFeedback = document.getElementById("busRouteFeedback");
        var busNumberInput = document.getElementById("busNumber");
        var stmRouteDirectory = null;
        var routeDirectoryReady = false;
        var routeDirectoryError = false;
        var ROUTE_DIRECTORY_CACHE_KEY = "speedbus.stmRouteDirectory.v1";

        try {
          var cachedRouteDirectory = JSON.parse(localStorage.getItem(ROUTE_DIRECTORY_CACHE_KEY) || "null");
          if (cachedRouteDirectory && cachedRouteDirectory.routes && typeof cachedRouteDirectory.routes === "object") {
            stmRouteDirectory = cachedRouteDirectory;
            routeDirectoryReady = true;
          }
        } catch (e) {}

        function lookupStmRoute(rawValue) {
          var value = String(rawValue || "").trim();
          if (!value) return { error: "Enter an STM route number." };
          if (!/^\d{1,3}$/.test(value)) return { error: "Enter the route number only." };
          if (!routeDirectoryReady) {
            return { error: routeDirectoryError ? "The STM directory could not load. Check your connection and reload." : "The STM directory is still loading." };
          }
          var number = String(Number(value));
          var route = stmRouteDirectory.routes[number];
          return route ? { number: number, name: route.name } : { error: "Route " + value + " is not in the current STM directory." };
        }

        function updateRouteFeedback() {
          var value = busRouteInput.value.trim();
          if (!value) {
            busRouteFeedback.className = routeDirectoryReady ? "route-feedback" : "route-feedback loading";
            busRouteFeedback.textContent = routeDirectoryReady ? "Enter an STM route number." : "Loading STM route directory…";
            return null;
          }
          var match = lookupStmRoute(value);
          if (match.error) {
            busRouteFeedback.className = routeDirectoryReady || routeDirectoryError ? "route-feedback invalid" : "route-feedback loading";
            busRouteFeedback.textContent = match.error;
            return null;
          }
          busRouteFeedback.className = "route-feedback valid";
          busRouteFeedback.textContent = "STM " + match.number + " — " + match.name;
          return match;
        }

        busRouteInput.addEventListener("input", updateRouteFeedback);
        fetch("./stm-routes.json", { cache: "no-cache" }).then(function (response) {
          if (!response.ok) throw new Error("Route directory unavailable");
          return response.json();
        }).then(function (catalog) {
          if (!catalog || !catalog.routes || typeof catalog.routes !== "object") throw new Error("Invalid route directory");
          stmRouteDirectory = catalog;
          routeDirectoryReady = true;
          routeDirectoryError = false;
          try { localStorage.setItem(ROUTE_DIRECTORY_CACHE_KEY, JSON.stringify(catalog)); } catch (e) {}
          updateRouteFeedback();
        }).catch(function () {
          routeDirectoryError = !routeDirectoryReady;
          updateRouteFeedback();
        });
        var directionInput = document.getElementById("direction");

        // ---------- dial drawing ----------
        function polar(cx, cy, r, deg) {
          var rad = (deg - 90) * Math.PI / 180;
          return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
        }
        function angleFor(valueInUnit) {
          var frac = valueInUnit / MAX;
          if (frac < 0) frac = 0;
          if (frac > 1) frac = 1;
          return SWEEP_START + frac * (SWEEP_END - SWEEP_START);
        }
        function drawTicks() {
          var step = 10;
          var majorEvery = 20;
          var max = MAX;
          var html = "";
          for (var v = 0; v <= max; v += step) {
            var a = SWEEP_START + (v / max) * (SWEEP_END - SWEEP_START);
            var major = (v % majorEvery === 0);
            var r1 = major ? 148 : 158;
            var p1 = polar(200, 200, r1, a);
            var p2 = polar(200, 200, 168, a);
            var hot = v >= 100;
            html += '<line x1="' + p1[0].toFixed(1) + '" y1="' + p1[1].toFixed(1) +
                    '" x2="' + p2[0].toFixed(1) + '" y2="' + p2[1].toFixed(1) +
                    '" stroke="' + (hot ? "#ff5a1f" : (major ? "var(--dial-tick-major)" : "var(--dial-tick)")) +
                    '" stroke-width="' + (major ? 4 : 2) + '" stroke-linecap="round" />';
            if (major) {
              var pl = polar(200, 200, 122, a);
              html += '<text class="tick-label" x="' + pl[0].toFixed(1) + '" y="' + pl[1].toFixed(1) +
                      '" font-size="24" text-anchor="middle" dominant-baseline="middle">' + v + "</text>";
            }
          }
          ticksG.innerHTML = html;
        }

        // ---------- conversion / formatting ----------
        function unitLabel() { return "km/h"; }
        function fmtTime(ms) {
          var s = Math.max(0, Math.floor(ms / 1000));
          var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
          var mm = (h > 0 && m < 10) ? "0" + m : "" + m;
          var ss = sec < 10 ? "0" + sec : "" + sec;
          return h > 0 ? h + ":" + mm + ":" + ss : m + ":" + ss;
        }

        function renderStats() {
          statMax.textContent = Math.round(maxKmh);
          var currentTrip = trip || displayedTrip;
          var now = Date.now();
          var elapsed = currentTrip ? (trip ? Math.max(0, now - trip.startedAt) : (currentTrip.elapsedMs || 0)) : 0;
          var idle = currentTrip ? Number(currentTrip.idleTimeMs || 0) : 0;
          if (trip && trip.isIdle && trip.lastSpeedSampleAt) idle += Math.max(0, Math.min(now - trip.lastSpeedSampleAt, 30000));
          var movingElapsed = Math.max(0, elapsed - idle);
          var avg = movingElapsed > 0 ? (distM / 1000) / (movingElapsed / 3600000) : 0;
          statAvg.textContent = avg.toFixed(1);
          statDist.textContent = (distM / 1000).toFixed(2);
          statTime.textContent = fmtTime(elapsed);
          statBrakes.textContent = brakeCount;
          statIdle.textContent = fmtTime(idle);
        }

        // ---------- needle animation ----------
        function animate() {
          var diff = targetKmh - displayKmh;
          displayKmh += diff * 0.12;
          if (Math.abs(diff) < 0.05) displayKmh = targetKmh;
          var shown = displayKmh;
          needleGroup.setAttribute("transform", "rotate(" + angleFor(shown).toFixed(2) + " 200 200)");
          bigSpeed.textContent = Math.round(shown);
          requestAnimationFrame(animate);
        }

        // ---------- geo helpers ----------
        function haversineM(lat1, lon1, lat2, lon2) {
          var R = 6371000, toRad = Math.PI / 180;
          var dLat = (lat2 - lat1) * toRad, dLon = (lon2 - lon1) * toRad;
          var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                  Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) *
                  Math.sin(dLon / 2) * Math.sin(dLon / 2);
          return 2 * R * Math.asin(Math.sqrt(a));
        }
        function median(arr) {
          var s = arr.slice().sort(function (a, b) { return a - b; });
          return s[Math.floor(s.length / 2)];
        }

        function setStatus(mode, text) {
          dot.className = "dot" + (mode ? " " + mode : "");
          statusText.textContent = text;
        }
        function showMsg(title, body) {
          msg.innerHTML = "<strong></strong><span></span>";
          msg.querySelector("strong").textContent = title;
          msg.querySelector("span").textContent = body;
          msg.classList.add("show");
        }
        function hideMsg() { msg.classList.remove("show"); }

        function storageRead(key, fallback) {
          try { var value = localStorage.getItem(key); return value ? JSON.parse(value) : fallback; }
          catch (e) { return fallback; }
        }
        function saveActive() {
          if (!trip) return;
          try { localStorage.setItem(ACTIVE_KEY, JSON.stringify(trip)); }
          catch (e) { showMsg("Phone storage is full", "This trip could not be saved locally. Download or remove older saved trips after stopping."); }
        }
        function saveTrips() {
          try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(savedTrips.slice(0, 30)));
            return true;
          } catch (e) {
            showMsg("Phone storage is full", "The trip summary could not be saved. The active recovery copy will be kept until you can download or clear space for the trip.");
            return false;
          }
        }
        function addObservation(observation) {
          if (!trip) return;
          trip.observations.push(observation);
          saveActive();
        }
        function onPosition(pos) {
          hideMsg();
          if (!tracking || !trip) return;
          var c = pos.coords;
          var t = pos.timestamp || Date.now();
          var accuracy = Number(c.accuracy);
          var lat = Number(c.latitude), lon = Number(c.longitude);
          var observation = {
            timestamp: new Date(t).toISOString(), latitude: isFinite(lat) ? lat : null,
            longitude: isFinite(lon) ? lon : null, accuracyM: isFinite(accuracy) ? accuracy : null,
            gpsSpeedMps: (typeof c.speed === "number" && isFinite(c.speed)) ? c.speed : null,
            speedKmh: null, accepted: false, rejectionReason: ""
          };
          if (!isFinite(lat) || !isFinite(lon) || !isFinite(accuracy) || accuracy <= 0) {
            observation.rejectionReason = "invalid_position_or_accuracy";
            addObservation(observation);
            setStatus("wait", "GPS fix is invalid — waiting for a better signal");
            return;
          }
          if (accuracy > MAX_ACCURACY_M) {
            observation.rejectionReason = "accuracy_over_35m";
            addObservation(observation);
            accuracyEl.textContent = "±" + Math.round(accuracy) + " m";
            setStatus("wait", "Weak GPS signal — fix accuracy is over 35 m");
            return;
          }

          var derivedKmh = null, movedM = 0, dt = 0;
          if (lastFix) {
            dt = (t - lastFix.t) / 1000;
            movedM = haversineM(lastFix.lat, lastFix.lon, lat, lon);
            if (dt >= 1 && dt <= 30 && movedM <= dt * 36 && movedM > Math.max(5, (accuracy + lastFix.accuracy) * 0.5)) {
              derivedKmh = (movedM / dt) * MS_TO_KMH;
            }
            // Ignore long gaps for distance; the GPS may have been suspended.
            if (dt > 0 && dt <= 30 && movedM > Math.max(3, (accuracy + lastFix.accuracy) * 0.2) && movedM <= dt * 36) {
              distM += movedM;
            }
          }
          var gpsKmh = observation.gpsSpeedMps === null || observation.gpsSpeedMps < 0 ? null : observation.gpsSpeedMps * MS_TO_KMH;
          if (gpsKmh === 0 && derivedKmh !== null && derivedKmh > 2) gpsKmh = null;
          var kmh = gpsKmh !== null && gpsKmh <= MAX_SPEED_KMH ? gpsKmh : derivedKmh;
          if (gpsKmh !== null && gpsKmh > MAX_SPEED_KMH) observation.rejectionReason = "gps_speed_over_130kmh";
          if (kmh === null) {
            kmh = recent.length ? recent[recent.length - 1] : 0;
            observation.rejectionReason = observation.rejectionReason || "no_usable_speed_sample";
          }
          if (lastFix && dt > 0 && dt <= 3 && Math.abs(kmh - lastFix.speedKmh) > 50 && kmh > 8) {
            observation.rejectionReason = "implausible_speed_jump";
            kmh = lastFix.speedKmh;
          }
          lastFix = { lat: lat, lon: lon, t: t, accuracy: accuracy, speedKmh: kmh };
          recent.push(kmh);
          if (recent.length > 5) recent.shift();
          var smooth = median(recent);
          if (smooth < 1.2) smooth = 0;
          targetKmh = smooth;
          var isIdleNow = smooth === 0;
          if (trip.lastSpeedSampleAt) {
            var sampleInterval = t - trip.lastSpeedSampleAt;
            if (trip.isIdle && sampleInterval > 0 && sampleInterval <= 30000) {
              trip.idleTimeMs = (trip.idleTimeMs || 0) + sampleInterval;
            }
          } else if (isIdleNow) {
            var initialIdle = t - trip.startedAt;
            if (initialIdle > 0 && initialIdle <= 30000) trip.idleTimeMs = initialIdle;
          }
          trip.lastSpeedSampleAt = t;
          trip.isIdle = isIdleNow;
          observation.speedKmh = Number(kmh.toFixed(2));
          observation.accepted = observation.rejectionReason === "" || observation.rejectionReason === "no_usable_speed_sample";
          if (!observation.rejectionReason) observation.rejectionReason = null;

          var previous = trip.lastAcceptedSpeed;
          if (previous && previous.speedKmh >= 25 && previous.speedKmh - smooth >= 15 && (t - previous.timestampMs) <= 3000 && (t - lastBrakeAt) >= 8000) {
            brakeCount++;
            lastBrakeAt = t;
            trip.brakingEvents.push({ timestamp: new Date(t).toISOString(), fromKmh: Number(previous.speedKmh.toFixed(1)), toKmh: Number(smooth.toFixed(1)), possible: true });
          }
          if (observation.accepted) trip.lastAcceptedSpeed = { speedKmh: smooth, timestampMs: t };
          if (observation.accepted && smooth > maxKmh) maxKmh = smooth;
          trip.distanceM = distM;
          trip.maxSpeedKmh = maxKmh;
          trip.possibleHardBrakingEvents = brakeCount;
          addObservation(observation);

          setStatus("live", "GPS tracking — trip recording");
          accuracyEl.textContent = "±" + Math.round(accuracy) + " m";
          renderStats();
          renderHistory();
        }

        function onError(err) {
          if (err.code === 1) {
            setStatus("err", "Location access blocked");
            showMsg("Allow location access", "SpeedBus needs your phone’s location while recording. Enable location access for this page in your browser, then start the trip again.");
            finishTrip(true, "Location permission was denied", true);
          } else if (err.code === 3) {
            setStatus("wait", "GPS unavailable — waiting for a location fix");
          } else {
            setStatus("wait", "GPS signal lost — waiting to reconnect");
          }
        }

        // ---------- wake lock ----------
        function grabWakeLock() {
          if ("wakeLock" in navigator) {
            navigator.wakeLock.request("screen").then(function (lock) {
              wakeLock = lock;
            }).catch(function () { /* not critical */ });
          }
        }
        document.addEventListener("visibilitychange", function () {
          if (!tracking) return;
          if (document.visibilityState === "hidden") {
            trip.lastVisibleAt = Date.now();
            setStatus("wait", "Page hidden — GPS may pause while the phone is locked");
            saveActive();
          } else {
            if (trip.lastVisibleAt && Date.now() - trip.lastVisibleAt > 15000) {
              lastFix = null; recent = []; targetKmh = 0;
              setStatus("wait", "Tracking resumed — GPS signal may have been interrupted");
            }
            trip.lastVisibleAt = null;
            grabWakeLock();
          }
        });

        // ---------- start / stop ----------
        function startTracking() {
          var route = busRouteInput.value.trim();
          if (!route) {
            showMsg("Bus route required", "Enter the bus route before starting a trip.");
            busRouteInput.focus();
            return;
          }
          var routeChoice = updateRouteFeedback();
          if (!routeChoice) {
            showMsg("Check bus route", busRouteFeedback.textContent);
            busRouteInput.focus();
            return;
          }
          route = routeChoice.number;
          busRouteInput.value = route;
          if (!("geolocation" in navigator)) {
            setStatus("err", "GPS not available");
            showMsg("No GPS on this device",
              "This browser doesn't provide location, so speed can't be measured here. Try opening this page on your phone.");
            return;
          }
          hideMsg();
          if (!trip) {
            maxKmh = 0; distM = 0; brakeCount = 0; lastBrakeAt = 0; recent = []; displayedTrip = null;
            trip = { id: "trip-" + Date.now(), startedAt: Date.now(), stoppedAt: null, busRoute: route, busRouteName: routeChoice.name, busNumber: busNumberInput.value.trim() || null, direction: directionInput.value || null, distanceM: 0, maxSpeedKmh: 0, idleTimeMs: 0, isIdle: false, lastSpeedSampleAt: null, possibleHardBrakingEvents: 0, brakingEvents: [], observations: [], comments: [], complete: false, interrupted: false };
          }
          setStatus("wait", "Waiting for a GPS signal…");
          tracking = true;
          toggleBtnLabel.textContent = "STOP TRIP";
          toggleBtn.classList.remove("start");
          toggleBtn.classList.add("stop");
          toggleBtn.setAttribute("aria-label", "Stop trip");
          busRouteInput.disabled = true;
          busNumberInput.disabled = true;
          directionInput.disabled = true;
          tripCommentInput.disabled = false;
          addCommentBtn.disabled = false;
          renderComments();
          timerId = setInterval(function () { renderStats(); saveActive(); }, 5000);
          saveActive();
          watchId = navigator.geolocation.watchPosition(onPosition, onError, {
            enableHighAccuracy: true,
            maximumAge: 1000,
            timeout: 15000
          });
          grabWakeLock();
        }
        function finishTrip(interrupted, reason, showStatus) {
          if (!trip) return;
          tracking = false;
          if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
          if (timerId) { clearInterval(timerId); timerId = null; }
          if (wakeLock) { try { wakeLock.release(); } catch (e) {} wakeLock = null; }
          targetKmh = 0;
          lastFix = null;
          trip.stoppedAt = interrupted ? (trip.observations.length ? Date.parse(trip.observations[trip.observations.length - 1].timestamp) : Date.now()) : Date.now();
          if (trip.isIdle && trip.lastSpeedSampleAt) {
            var finalIdleInterval = trip.stoppedAt - trip.lastSpeedSampleAt;
            if (finalIdleInterval > 0 && finalIdleInterval <= 30000) trip.idleTimeMs = (trip.idleTimeMs || 0) + finalIdleInterval;
          }
          trip.isIdle = false;
          trip.elapsedMs = Math.max(0, trip.stoppedAt - trip.startedAt);
          trip.idleTimeMs = Number(trip.idleTimeMs || 0);
          trip.distanceM = distM;
          trip.maxSpeedKmh = maxKmh;
          var movingElapsedMs = Math.max(0, trip.elapsedMs - trip.idleTimeMs);
          trip.averageSpeedKmh = movingElapsedMs > 0 ? (distM / 1000) / (movingElapsedMs / 3600000) : 0;
          trip.possibleHardBrakingEvents = brakeCount;
          trip.complete = !interrupted;
          trip.interrupted = !!interrupted;
          trip.interruptionReason = reason || null;
          delete trip.lastAcceptedSpeed;
          delete trip.lastVisibleAt;
          displayedTrip = trip;
          savedTrips.unshift(trip);
          savedTrips = savedTrips.slice(0, 30);
          var tripSaved = saveTrips();
          if (tripSaved) {
            try { localStorage.removeItem(ACTIVE_KEY); } catch (e) {}
          }
          trip = null;
          toggleBtnLabel.textContent = "START TRIP";
          toggleBtn.classList.remove("stop");
          toggleBtn.classList.add("start");
          toggleBtn.setAttribute("aria-label", "Start trip");
          busRouteInput.disabled = false;
          busNumberInput.disabled = false;
          directionInput.disabled = false;
          tripCommentInput.disabled = true;
          addCommentBtn.disabled = true;
          renderComments();
          accuracyEl.textContent = "";
          renderStats(); renderHistory();
          setStatus(interrupted || !tripSaved ? "wait" : "", !tripSaved ? "Trip kept for recovery — phone storage is full" : (showStatus || (interrupted ? "Trip saved — GPS tracking was interrupted" : "Trip saved on this phone")));
        }

        function renderComments() {
          var current = trip || displayedTrip;
          var comments = current && Array.isArray(current.comments) ? current.comments : [];
          commentList.innerHTML = "";
          comments.forEach(function (comment) {
            var item = document.createElement("li");
            var time = document.createElement("time");
            time.dateTime = comment.timestamp || "";
            time.textContent = fmtTime(comment.elapsedMs || 0) + " — ";
            item.appendChild(time);
            item.appendChild(document.createTextNode(comment.text || ""));
            commentList.appendChild(item);
          });
        }

        function addTripComment() {
          if (!tracking || !trip) return;
          var text = tripCommentInput.value.trim();
          if (!text) { tripCommentInput.focus(); return; }
          if (!Array.isArray(trip.comments)) trip.comments = [];
          var comment = { timestamp: new Date().toISOString(), elapsedMs: Math.max(0, Date.now() - trip.startedAt), text: text };
          if (lastFix) { comment.latitude = lastFix.lat; comment.longitude = lastFix.lon; }
          trip.comments.push(comment);
          tripCommentInput.value = "";
          saveActive();
          renderComments();
          tripCommentInput.focus();
        }

        addCommentBtn.addEventListener("click", addTripComment);
        tripCommentInput.addEventListener("keydown", function (event) {
          if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) addTripComment();
        });

        toggleBtn.addEventListener("click", function () {
          if (tracking) finishTrip(false, null, "Trip saved on this phone"); else startTracking();
        });

        function renderHistory() {
          if (!savedTrips.length) { tripHistory.innerHTML = '<p class="empty-history">No saved trips yet.</p>'; return; }
          tripHistory.innerHTML = "";
          savedTrips.forEach(function (saved, index) {
            var card = document.createElement("article");
            card.className = "trip-card";
            var title = document.createElement("strong");
            title.textContent = new Date(saved.startedAt).toLocaleString() + (saved.interrupted ? " · Interrupted" : "");
            var detail = document.createElement("div");
            detail.className = "trip-detail";
            detail.textContent = (saved.busRoute ? "Route " + saved.busRoute + (saved.busRouteName ? " — " + saved.busRouteName : "") + " · " : "") + (saved.busNumber ? "Bus " + saved.busNumber + " · " : (saved.busNumberOrId ? "Bus " + saved.busNumberOrId + " · " : "")) + (saved.direction ? "Direction " + saved.direction + " · " : "") + "Duration " + fmtTime(saved.elapsedMs || 0) + " · Distance " + ((saved.distanceM || 0) / 1000).toFixed(2) + " km · Top " + Math.round(saved.maxSpeedKmh || 0) + " km/h · Average " + Number(saved.averageSpeedKmh || 0).toFixed(1) + " km/h · Idle " + fmtTime(saved.idleTimeMs || 0) + " · Possible hard braking " + (saved.possibleHardBrakingEvents || 0) + " · " + ((saved.observations || []).length) + " GPS observations";
            var actions = document.createElement("div");
            actions.className = "trip-actions";
            var viewMap = document.createElement("button");
            viewMap.type = "button"; viewMap.textContent = "View trip map";
            viewMap.addEventListener("click", function () { showTripMap(saved); });
            actions.appendChild(viewMap);
            var download = document.createElement("button");
            download.type = "button"; download.textContent = "Download trip JSON";
            download.addEventListener("click", function () { downloadTrip(saved, index); });
            actions.appendChild(download);
            card.appendChild(title); card.appendChild(detail); card.appendChild(actions);
            tripHistory.appendChild(card);
          });
        }
        function downloadTrip(saved, index) {
          var blob = new Blob([JSON.stringify(saved, null, 2)], { type: "application/json" });
          var url = URL.createObjectURL(blob);
          var link = document.createElement("a");
          link.href = url;
          link.download = "speedbus-trip-" + new Date(saved.startedAt).toISOString().replace(/[:.]/g, "-") + ".json";
          document.body.appendChild(link); link.click(); link.remove();
          setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
        }

        function loadScriptOnce(id, src) {
          var existing = document.getElementById(id);
          if (existing) {
            if (existing.dataset.loaded === "true") return Promise.resolve();
            return new Promise(function (resolve, reject) {
              existing.addEventListener("load", resolve, { once: true });
              existing.addEventListener("error", reject, { once: true });
            });
          }
          return new Promise(function (resolve, reject) {
            var script = document.createElement("script");
            script.id = id; script.src = src; script.async = true;
            script.onload = function () { script.dataset.loaded = "true"; resolve(); };
            script.onerror = function () { reject(new Error("Could not load map helper")); };
            document.head.appendChild(script);
          });
        }

        function ensureLeaflet() {
          if (window.L) return Promise.resolve();
          if (!document.getElementById("leaflet-css")) {
            var css = document.createElement("link");
            css.id = "leaflet-css"; css.rel = "stylesheet";
            css.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
            document.head.appendChild(css);
          }
          return loadScriptOnce("leaflet-js", "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js");
        }

        function eachLineSegment(geometry, callback) {
          if (!geometry || !geometry.coordinates) return;
          var lines = geometry.type === "LineString" ? [geometry.coordinates] :
            (geometry.type === "MultiLineString" ? geometry.coordinates : []);
          lines.forEach(function (line) {
            for (var i = 1; i < line.length; i++) callback(line[i - 1], line[i]);
          });
        }

        function buildSpeedLimitGrid(collection) {
          var grid = Object.create(null);
          var cellSize = 0.002;
          function add(segment) {
            var latPad = 0.00035;
            var lonPad = 0.00045;
            var minLat = Math.min(segment.a[1], segment.b[1]) - latPad;
            var maxLat = Math.max(segment.a[1], segment.b[1]) + latPad;
            var minLon = Math.min(segment.a[0], segment.b[0]) - lonPad;
            var maxLon = Math.max(segment.a[0], segment.b[0]) + lonPad;
            for (var y = Math.floor(minLat / cellSize); y <= Math.floor(maxLat / cellSize); y++) {
              for (var x = Math.floor(minLon / cellSize); x <= Math.floor(maxLon / cellSize); x++) {
                var key = y + ":" + x;
                if (!grid[key]) grid[key] = [];
                grid[key].push(segment);
              }
            }
          }
          (collection.features || []).forEach(function (feature) {
            var p = feature.properties || {};
            var rawLimit = p.Vitesse || p.vitesse || p.VITESSE;
            var limit = Number.parseFloat(rawLimit);
            if (!Number.isFinite(limit) || limit <= 0 || limit > 130) return;
            eachLineSegment(feature.geometry, function (a, b) {
              if (a.length >= 2 && b.length >= 2) add({ a: a, b: b, limit: limit });
            });
          });
          return grid;
        }

        function ensureSpeedLimitGrid() {
          if (speedLimitGrid) return Promise.resolve(speedLimitGrid);
          if (speedLimitGridPromise) return speedLimitGridPromise;
          speedLimitGridPromise = ensureLeaflet().then(function () {
            return loadScriptOnce("shpjs-script", "https://unpkg.com/shpjs@latest/dist/shp.min.js");
          }).then(function () {
            if (!window.shp) throw new Error("Speed-limit file reader is unavailable");
            return fetch(SPEED_LIMIT_DATA_URL);
          }).then(function (response) {
            if (!response.ok) throw new Error("Speed-limit data could not be downloaded");
            return response.arrayBuffer();
          }).then(function (archive) {
            return window.shp(archive);
          }).then(function (geojson) {
            var collection = Array.isArray(geojson) ? geojson.find(function (item) { return item && item.features; }) : geojson;
            if (!collection || !collection.features) throw new Error("The Montréal speed-limit file was not readable");
            speedLimitGrid = buildSpeedLimitGrid(collection);
            return speedLimitGrid;
          }).catch(function (error) {
            speedLimitGridPromise = null;
            throw error;
          });
          return speedLimitGridPromise;
        }

        function distanceToSegmentM(lat, lon, segment) {
          var cosLat = Math.cos(lat * Math.PI / 180);
          var scaleX = 111320 * cosLat, scaleY = 111320;
          var px = 0, py = 0;
          var ax = (segment.a[0] - lon) * scaleX, ay = (segment.a[1] - lat) * scaleY;
          var bx = (segment.b[0] - lon) * scaleX, by = (segment.b[1] - lat) * scaleY;
          var dx = bx - ax, dy = by - ay;
          var denom = dx * dx + dy * dy;
          var t = denom ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / denom)) : 0;
          return Math.hypot(ax + t * dx, ay + t * dy);
        }

        function nearestSpeedLimit(lat, lon) {
          if (!speedLimitGrid) return null;
          var cellSize = 0.002;
          var cy = Math.floor(lat / cellSize), cx = Math.floor(lon / cellSize);
          var candidates = [];
          for (var y = cy - 1; y <= cy + 1; y++) {
            for (var x = cx - 1; x <= cx + 1; x++) {
              var bucket = speedLimitGrid[y + ":" + x];
              if (bucket) candidates = candidates.concat(bucket);
            }
          }
          var best = null, bestDistance = 35;
          candidates.forEach(function (segment) {
            var d = distanceToSegmentM(lat, lon, segment);
            if (d < bestDistance) { bestDistance = d; best = segment.limit; }
          });
          return best;
        }

        function clearTripMapLayers() {
          if (!tripMapInstance) return;
          tripMapLayers.forEach(function (layer) { tripMapInstance.removeLayer(layer); });
          tripMapLayers = [];
        }

        function showTripMap(saved) {
          mapPanel.hidden = false;
          mapStatus.textContent = "Loading trip map and Montréal speed limits…";
          mapPanel.scrollIntoView({ behavior: "smooth", block: "start" });
          var points = (saved.observations || []).filter(function (o) {
            return o && Number.isFinite(Number(o.latitude)) && Number.isFinite(Number(o.longitude)) &&
              Number.isFinite(Number(o.accuracyM)) && Number(o.accuracyM) <= 35;
          });
          if (points.length < 2) {
            mapStatus.textContent = "This trip does not have enough accurate GPS points to draw a route.";
            return;
          }
          ensureLeaflet().then(function () {
            if (!tripMapInstance) {
              tripMapInstance = window.L.map(tripMapEl, { scrollWheelZoom: false });
              tripMapTileLayer = window.L.tileLayer(MAP_TILE_URL, {
                maxZoom: 19,
                attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>'
              }).addTo(tripMapInstance);
            }
            return ensureSpeedLimitGrid().catch(function () { return null; });
          }).then(function () {
            clearTripMapLayers();
            var bounds = [];
            for (var i = 1; i < points.length; i++) {
              var previous = points[i - 1], current = points[i];
              var lat1 = Number(previous.latitude), lon1 = Number(previous.longitude);
              var lat2 = Number(current.latitude), lon2 = Number(current.longitude);
              var coords = [[lat1, lon1], [lat2, lon2]];
              bounds.push([lat1, lon1], [lat2, lon2]);
              var speed1 = Number(previous.speedKmh), speed2 = Number(current.speedKmh);
              var haveSpeeds = previous.speedKmh !== null && previous.speedKmh !== undefined &&
                current.speedKmh !== null && current.speedKmh !== undefined &&
                previous.rejectionReason !== "no_usable_speed_sample" &&
                current.rejectionReason !== "no_usable_speed_sample" &&
                Number.isFinite(speed1) && Number.isFinite(speed2);
              var measured = haveSpeeds ? (speed1 + speed2) / 2 : null;
              var limit = nearestSpeedLimit((lat1 + lat2) / 2, (lon1 + lon2) / 2);
              var aboveLimit = measured !== null && limit !== null && measured >= limit + 5;
              var line = window.L.polyline(coords, {
                color: aboveLimit ? "#d62828" : "#1677d2",
                weight: 6, opacity: 0.9
              }).addTo(tripMapInstance);
              var detail = measured === null ? "GPS speed unavailable" : "Recorded speed: " + measured.toFixed(1) + " km/h";
              detail += limit === null ? " · No Montréal speed limit matched" : " · Mapped permanent limit: " + limit + " km/h";
              if (aboveLimit) detail += " · 5+ km/h above mapped limit";
              line.bindPopup(detail);
              tripMapLayers.push(line);
            }
            if (points.length) {
              var first = points[0], last = points[points.length - 1];
              tripMapLayers.push(window.L.marker([Number(first.latitude), Number(first.longitude)]).addTo(tripMapInstance).bindPopup("Trip start"));
              tripMapLayers.push(window.L.marker([Number(last.latitude), Number(last.longitude)]).addTo(tripMapInstance).bindPopup("Trip end"));
            }
            tripMapInstance.fitBounds(bounds, { padding: [20, 20] });
            window.setTimeout(function () { tripMapInstance.invalidateSize(); }, 100);
            mapStatus.textContent = speedLimitGrid
              ? "Approximate GPS route. Red sections are 5+ km/h above a matched permanent Montréal speed limit; blue includes both below-limit and unmatched sections. School-period limits are not applied automatically. The map uses OpenStreetMap tiles."
              : "Approximate GPS route shown in blue. Montréal speed-limit data is unavailable, so no sections are classified as above the limit. The map uses OpenStreetMap tiles.";
          }).catch(function () {
            mapStatus.textContent = "The route map or Montréal speed-limit data could not load. Try again with a stable internet connection.";
          });
        }

        window.addEventListener("pagehide", function () {
          if (tracking && trip) finishTrip(true, "Page was closed, reloaded, or suspended", "Trip saved as interrupted");
        });

        // ---------- init ----------
        savedTrips = storageRead(STORAGE_KEY, []);
        if (!Array.isArray(savedTrips)) savedTrips = [];
        if (savedTrips.length) {
          displayedTrip = savedTrips[0];
          maxKmh = Number(displayedTrip.maxSpeedKmh || 0);
          distM = Number(displayedTrip.distanceM || 0);
          brakeCount = Number(displayedTrip.possibleHardBrakingEvents || 0);
        }
        var recovered = storageRead(ACTIVE_KEY, null);
        if (recovered && recovered.startedAt) {
          var recoveredEnd = recovered.observations && recovered.observations.length ? Date.parse(recovered.observations[recovered.observations.length - 1].timestamp) : recovered.startedAt;
          recovered.stoppedAt = recoveredEnd;
          recovered.elapsedMs = Math.max(0, recoveredEnd - recovered.startedAt);
          recovered.interrupted = true; recovered.complete = false;
          recovered.interruptionReason = "Page was reloaded or tracking was interrupted";
          recovered.distanceM = recovered.distanceM || 0;
          recovered.maxSpeedKmh = recovered.maxSpeedKmh || 0;
          recovered.idleTimeMs = Number(recovered.idleTimeMs || 0);
          var recoveredMovingMs = Math.max(0, recovered.elapsedMs - recovered.idleTimeMs);
          recovered.averageSpeedKmh = recoveredMovingMs > 0 ? (recovered.distanceM / 1000) / (recoveredMovingMs / 3600000) : 0;
          var alreadyRecovered = savedTrips.some(function (saved) { return saved.id && saved.id === recovered.id; });
          if (!alreadyRecovered) savedTrips.unshift(recovered);
          savedTrips = savedTrips.slice(0, 30);
          var recoverySaved = saveTrips();
          displayedTrip = recovered;
          maxKmh = Number(recovered.maxSpeedKmh || 0); distM = Number(recovered.distanceM || 0); brakeCount = Number(recovered.possibleHardBrakingEvents || 0);
          if (recoverySaved) {
            try { localStorage.removeItem(ACTIVE_KEY); } catch (e) {}
            setStatus("wait", "Previous trip saved — tracking was interrupted");
          } else {
            setStatus("wait", "Recovered trip is still available — download it to keep a copy");
          }
        }
        drawTicks();
        renderHistory();
        renderComments();
        renderStats();
        requestAnimationFrame(animate);
      })();


// Register the offline app shell. Trip data remains in local browser storage.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", function () {
    navigator.serviceWorker.register("./service-worker.js").catch(function () {});
  });
}
