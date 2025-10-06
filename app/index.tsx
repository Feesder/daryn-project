import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert, Animated,
  Dimensions,
  FlatList,
  PanResponder,
  StyleSheet,
  Text,
  TextInput, TouchableOpacity,
  View
} from "react-native";
import MapView, {
  Callout,
  Marker, Polyline, PROVIDER_DEFAULT,
  UserLocationChangeEvent
} from "react-native-maps";

/** ---------- Types ---------- */
type Coord = { lat: number; lon: number };
type XY = { latitude: number; longitude: number };
type StatusKey = "idle" | "loading" | "ok" | "error";

type OSRMResponse = {
  code: "Ok" | string;
  routes?: OSRMRoute[];
  waypoints?: { name: string; location: [number, number] }[];
  message?: string;
};

type OSRMRoute = {
  geometry: { coordinates: [number, number][]; type: "LineString" };
  distance: number;
  duration: number;
  weight: number;
  weight_name: string;
  legs: OSRMLeg[];
};

type OSRMLeg = {
  distance: number;
  duration: number;
  summary: string;
  steps: OSRMStep[];
};

type OSRMStep = {
  distance: number;
  duration: number;
  name: string;
  geometry: { coordinates: [number, number][]; type: "LineString" };
  maneuver: {
    location: [number, number];
    type:
      | "arrive" | "depart" | "merge" | "turn" | "continue" | "roundabout"
      | "fork" | "end of road" | "rotary" | "new name" | "notification"
      | "exit roundabout" | "exit rotary" | string;
    modifier?:
      | "uturn" | "sharp right" | "right" | "slight right" | "straight"
      | "slight left" | "left" | "sharp left" | string;
  };
};

type NearestResp = {
  code: string;
  waypoints?: { name: string; location: [number, number]; hint?: string; distance?: number }[];
};

type TurnNode = {
  id: string;
  coordinate: XY;
  street: string;
  maneuverType: string;
  modifier?: string;
  stepDistance: number;
  stepDuration: number;
  routeIndex: number;
};

type RouteView = {
  id: string;
  index: number;
  coords: XY[];
  distance: number;
  duration: number;
  color: string;
  isPrimary: boolean;
  turnNodes: TurnNode[];
};

type RouteMarker = {
  id: string;
  coordinate: XY;
  coveredDistance: number;
  remainDistance: number;
  remainDuration: number;
};

/** ---------- Utils ---------- */
const toXY = (coord: [number, number]): XY => ({ latitude: coord[1], longitude: coord[0] });
const fmtDist = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1)} км` : `${Math.round(m)} м`);
const fmtDur = (s: number) => {
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return h > 0 ? `${h} ч ${m} мин` : `${m} мин`;
};
const COLORS = ["#0A84FF", "#32D74B", "#FF9F0A", "#5E5CE6", "#64D2FF"];
const TINT = "#0A84FF";
const SURFACE = "rgba(28,28,30,0.94)";
const STROKE = "rgba(255,255,255,0.10)";
const TEXT = "#FFFFFF";
const SUBTLE = "#B9B9BD";

const fetchWithTimeout = async (url: string, ms = 9000): Promise<Response> => {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    return res;
  } finally {
    clearTimeout(t);
  }
};

const coordsToParam = (coords: Coord[]) =>
  coords.map((c) => `${c.lon},${c.lat}`).join(";");

const sigForRoute = (r: OSRMRoute) => {
  const first = r.geometry.coordinates[0];
  const last = r.geometry.coordinates[r.geometry.coordinates.length - 1];
  const len = r.geometry.coordinates.length;
  return `${Math.round(r.distance)}|${Math.round(r.duration)}|${first?.[0].toFixed(3)},${first?.[1].toFixed(3)}|${last?.[0].toFixed(3)},${last?.[1].toFixed(3)}|${len}`;
};

// геодезия (Хаверсин)
const R = 6371000; // м
const toRad = (deg: number) => (deg * Math.PI) / 180;
const haversine = (a: XY, b: XY) => {
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h)); // м
};

// точки каждые spacing метров вдоль ломаной
const sampleEveryMeters = (poly: XY[], spacing = 100, maxCount = 400): RouteMarker[] => {
  if (!poly.length) return [];
  let acc = 0;
  const cum: number[] = [0];
  for (let i = 1; i < poly.length; i++) {
    acc += haversine(poly[i - 1], poly[i]);
    cum.push(acc);
  }
  const total = acc;
  if (total === 0) return [];
  const out: RouteMarker[] = [];
  let target = spacing;
  let idx = 1;
  while (target < total && out.length < maxCount) {
    while (idx < poly.length && cum[idx] < target) idx++;
    if (idx >= poly.length) break;
    const prev = poly[idx - 1];
    const next = poly[idx];
    const segLen = cum[idx] - cum[idx - 1];
    const remainInSeg = target - cum[idx - 1];
    const t = segLen > 0 ? remainInSeg / segLen : 0;
    const lat = prev.latitude + (next.latitude - prev.latitude) * t;
    const lon = prev.longitude + (next.longitude - prev.longitude) * t;
    out.push({
      id: `m-${out.length}-${idx}`,
      coordinate: { latitude: lat, longitude: lon },
      coveredDistance: target,
      remainDistance: total - target,
      remainDuration: 0,
    });
    target += spacing;
  }
  return out;
};

/** ---------- App ---------- */
export default function App() {
  const mapRef = useRef<MapView | null>(null);
  const initialRegion = useMemo(
    () => ({ latitude: 43.238949, longitude: 76.889709, latitudeDelta: 0.25, longitudeDelta: 0.25 }),
    []
  );

  const [activeSetter, setActiveSetter] = useState<"A" | "B">("A");
  const [A, setA] = useState<Coord | null>(null);
  const [B, setB] = useState<Coord | null>(null);
  const [latA, setLatA] = useState<string>(""); const [lonA, setLonA] = useState<string>("");
  const [latB, setLatB] = useState<string>(""); const [lonB, setLonB] = useState<string>("");

  const [routes, setRoutes] = useState<RouteView[]>([]);
  const [selectedRoute, setSelectedRoute] = useState<number>(0);
  const [showNodes] = useState<boolean>(true); // всегда показываем узлы
  const [loading, setLoading] = useState<boolean>(false);

  // Переключатель отображения всех маршрутов
  const [showAllRoutes, setShowAllRoutes] = useState<boolean>(true);

  const [statusKey, setStatusKey] = useState<StatusKey>("idle");
  const [statusText, setStatusText] = useState<string>("Готов к построению");
  const [errorText, setErrorText] = useState<string | null>(null);

  const [myLocation, setMyLocation] = useState<XY | null>(null);
  const handleUserLocation = (e: UserLocationChangeEvent) => {
    const c = e.nativeEvent.coordinate;
    if (c && c.latitude && c.longitude) setMyLocation({ latitude: c.latitude, longitude: c.longitude });
  };

  /** ---------- Bottom Sheet ---------- */
  const screenH = Dimensions.get("window").height;
  const SHEET_EXPANDED = Math.min(520, Math.max(380, Math.round(screenH * 0.56)));
  const SHEET_COLLAPSED = 64;
  const sheetY = useRef(new Animated.Value(0)).current; // 0=open, 1=closed
  const [sheetOpen, setSheetOpen] = useState(true);

  const openSheet = (animated = true) => {
    setSheetOpen(true);
    Animated.timing(sheetY, { toValue: 0, duration: animated ? 220 : 0, useNativeDriver: true }).start();
  };
  const closeSheet = (animated = true) => {
    setSheetOpen(false);
    Animated.timing(sheetY, { toValue: 1, duration: animated ? 220 : 0, useNativeDriver: true }).start();
  };

  const translateY = sheetY.interpolate({
    inputRange: [0, 1],
    outputRange: [0, SHEET_EXPANDED - SHEET_COLLAPSED],
  });

  const pan = useRef(new Animated.Value(0)).current;
  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: () => { pan.setValue(0); },
      onPanResponderMove: (_, g) => { pan.setValue(Math.max(0, g.dy)); },
      onPanResponderRelease: (_, g) => {
        const threshold = 80;
        if (g.vy > 0.6 || g.dy > threshold) closeSheet(); else openSheet();
        Animated.timing(pan, { toValue: 0, duration: 120, useNativeDriver: true }).start();
      },
    })
  ).current;

  const sheetStyle = { transform: [{ translateY: Animated.add(translateY, pan) }] };

  const statusColors = {
    idle: { dot: "#8E8E93", bg: "rgba(255,255,255,0.08)", text: "#E5E5EA" },
    loading: { dot: "#0A84FF", bg: "rgba(10,132,255,0.15)", text: "#D6E7FF" },
    ok: { dot: "#34C759", bg: "rgba(52,199,89,0.18)", text: "#D6FFE0" },
    error: { dot: "#FF453A", bg: "rgba(255,69,58,0.18)", text: "#FFDAD7" },
  } as const;

  /** ---------- Map interactions ---------- */
  const onMapPress = useCallback((e: any) => {
    // Тап по маркеру = только инфо, точки ставим по свободным местам
    if (e?.nativeEvent?.action === "marker-press") return;
    const { latitude, longitude } = e.nativeEvent.coordinate as XY;
    if (activeSetter === "A") {
      setA({ lat: latitude, lon: longitude });
      setLatA(latitude.toFixed(6)); setLonA(longitude.toFixed(6));
    } else {
      setB({ lat: latitude, lon: longitude });
      setLatB(latitude.toFixed(6)); setLonB(longitude.toFixed(6));
    }
  }, [activeSetter]);

  const onChangeCoordInput = (setter: (c: Coord) => void, latStr?: string, lonStr?: string) => {
    if (!latStr || !lonStr) return;
    const lat = parseFloat(latStr); const lon = parseFloat(lonStr);
    if (!isNaN(lat) && !isNaN(lon)) setter({ lat, lon });
  };

  const nearestHint = useCallback(async (c: Coord): Promise<{ coord: Coord; hint?: string }> => {
    try {
      const url = `https://router.project-osrm.org/nearest/v1/driving/${c.lon},${c.lat}?number=1`;
      const r = await fetchWithTimeout(url);
      if (!r.ok) return { coord: c };
      const data: NearestResp = await r.json();
      const wp = data?.waypoints?.[0];
      if (wp?.location) {
        const [lon, lat] = wp.location;
        return { coord: { lat, lon }, hint: wp.hint };
      }
      return { coord: c };
    } catch {
      return { coord: c };
    }
  }, []);

  const buildInstruction = (s: OSRMStep) => {
    const t = s.maneuver.type;
    const m = s.maneuver.modifier ? `, ${s.maneuver.modifier}` : "";
    if (t === "arrive") return "Прибытие";
    if (t === "depart") return "Начало движения";
    if (t === "turn") return `Поворот${m}`;
    if (t === "continue") return `Двигайтесь прямо${m}`;
    if (t === "merge") return `Перестроение${m}`;
    if (t === "fork") return `Развилка${m}`;
    if (t === "roundabout" || t === "rotary") return "Кольцевое движение";
    if (t === "end of road") return `Конец дороги${m}`;
    return `${t}${m}`;
  };

  const makeRouteUrl = (coords: Coord[], opts?: { hints?: (string | undefined)[]; wantAlternatives?: boolean }) => {
    const base = `https://router.project-osrm.org/route/v1/driving/${coordsToParam(coords)}`;
    const params = [
      opts?.wantAlternatives ? "alternatives=true" : undefined,
      "steps=true",
      "annotations=distance,duration",
      "geometries=geojson",
      "overview=full",
    ].filter(Boolean);
    if (opts?.hints && opts.hints.length === coords.length && opts.hints.every(Boolean)) {
      params.push(`hints=${opts.hints.map((h) => encodeURIComponent(h!)).join(";")}`);
    }
    return `${base}?${params.join("&")}`;
  };

  const mapToViews = (list: OSRMRoute[]) => {
    const bestIdx = list.map((r, i) => ({ i, d: r.duration })).sort((a, b) => a.d - b.d)[0]?.i ?? 0;
    const mapped: RouteView[] = list.slice(0, 5).map((r, idx) => {
      const coords: XY[] = r.geometry.coordinates.map(toXY);
      const nodes: TurnNode[] = r.legs.flatMap((leg, legIndex) =>
        leg.steps.map((s, stepIndex) => {
          const ll = toXY(s.maneuver.location);
          return {
            id: `r${idx}-l${legIndex}-s${stepIndex}`,
            coordinate: ll,
            street: s.name || "Без названия",
            maneuverType: buildInstruction(s),
            modifier: s.maneuver.modifier,
            stepDistance: s.distance,
            stepDuration: s.duration,
            routeIndex: idx,
          };
        })
      );
      return {
        id: `route-${idx}`,
        index: idx,
        coords,
        distance: r.distance,
        duration: r.duration,
        color: COLORS[idx % COLORS.length],
        isPrimary: idx === bestIdx,
        turnNodes: nodes,
      };
    });
    return { mapped, bestIdx };
  };

  // via-кандидаты для добора альтернатив (чтобы добить до 5)
  const makeViaCandidates = (a: Coord, b: Coord): Coord[] => {
    const midLat = (a.lat + b.lat) / 2;
    const midLon = (a.lon + b.lon) / 2;
    const latSpan = Math.max(0.005, Math.abs(a.lat - b.lat));
    const lonSpan = Math.max(0.005, Math.abs(a.lon - b.lon));
    const dLat = Math.min(0.03, latSpan * 0.6);
    const dLon = Math.min(0.03, lonSpan * 0.6);
    return [
      { lat: midLat + dLat, lon: midLon },
      { lat: midLat - dLat, lon: midLon },
      { lat: midLat, lon: midLon + dLon },
      { lat: midLat, lon: midLon - dLon },
      { lat: midLat + dLat, lon: midLon + dLon },
      { lat: midLat - dLat, lon: midLon + dLon },
      { lat: midLat + dLat, lon: midLon - dLon },
      { lat: midLat - dLat, lon: midLon - dLon },
      { lat: midLat + dLat * 1.5, lon: midLon },
      { lat: midLat, lon: midLon + dLon * 1.5 },
      { lat: midLat - dLat * 1.5, lon: midLon },
      { lat: midLat, lon: midLon - dLon * 1.5 },
    ];
  };

  const fetchFiveRoutes = useCallback(async (A0: Coord, B0: Coord) => {
    setStatusText("Запрашиваем альтернативы…"); setStatusKey("loading");
    const out: OSRMRoute[] = [];
    const seen = new Set<string>();

    const [aH, bH] = await Promise.all([nearestHint(A0), nearestHint(B0)]);

    // A→B с alternatives=true
    try {
      const url = makeRouteUrl([aH.coord, bH.coord], { hints: [aH.hint, bH.hint], wantAlternatives: true });
      const res = await fetchWithTimeout(url);
      if (res.status === 429) throw new Error("Демо-сервер перегружен (429). Повторите позже.");
      if (res.status === 400) throw new Error("Неверный запрос (400). Поставьте точки ближе к дороге.");
      if (!res.ok) throw new Error(`Сервер ответил ${res.status}`);
      const data: OSRMResponse = await res.json();
      if (data.code === "Ok" && data.routes?.length) {
        for (const r of data.routes) {
          const k = sigForRoute(r);
          if (!seen.has(k)) { seen.add(k); out.push(r); if (out.length >= 5) break; }
        }
      }
    } catch (e) {
      setErrorText((e as Error)?.message ?? "Ошибка OSRM");
    }

    if (out.length >= 5) return out.slice(0, 5);

    // добор через via
    const vias = makeViaCandidates(aH.coord, bH.coord);
    for (const via of vias) {
      if (out.length >= 5) break;
      try {
        const url = makeRouteUrl([aH.coord, via, bH.coord]);
        const res = await fetchWithTimeout(url);
        if (!res.ok) continue;
        const data: OSRMResponse = await res.json();
        if (data.code !== "Ok" || !data.routes?.length) continue;
        const r = data.routes[0];
        const k = sigForRoute(r);
        if (!seen.has(k)) { seen.add(k); out.push(r); }
      } catch {}
    }

    if (out.length < 5) {
      const farVias = makeViaCandidates(
        { lat: aH.coord.lat + 0.01, lon: aH.coord.lon + 0.01 },
        { lat: bH.coord.lat - 0.01, lon: bH.coord.lon - 0.01 }
      );
      for (const via of farVias) {
        if (out.length >= 5) break;
        try {
          const url = makeRouteUrl([aH.coord, via, bH.coord]);
          const res = await fetchWithTimeout(url);
          if (!res.ok) continue;
          const data: OSRMResponse = await res.json();
          if (data.code !== "Ok" || !data.routes?.length) continue;
          const r = data.routes[0];
          const k = sigForRoute(r);
          if (!seen.has(k)) { seen.add(k); out.push(r); }
        } catch {}
      }
    }

    return out.slice(0, 5);
  }, [nearestHint]);

  const fetchRoutes = useCallback(async () => {
    if (!A || !B) {
      Alert.alert("Маршрут", "Сначала выберите точки A и B.");
      return;
    }
    setLoading(true);
    setErrorText(null);
    setStatusText("Строим до 5 вариантов…");
    setStatusKey("loading");
    setRoutes([]);

    try {
      const got = await fetchFiveRoutes(A, B);
      if (!got.length) throw new Error("OSRM не смог построить маршрут. Попробуйте ближе к дороге.");
      const { mapped, bestIdx } = mapToViews(got);
      setRoutes(mapped);
      setSelectedRoute(bestIdx);
      setShowAllRoutes(true); // после построения показываем все
      setStatusText(`Готово: маршрутов ${mapped.length}`);
      setStatusKey("ok");
    } catch (err: any) {
      const msg = typeof err?.message === "string" ? err.message : "Не удалось построить маршрут.";
      setErrorText(msg);
      setStatusText("Ошибка");
      setStatusKey("error");
      Alert.alert("OSRM", msg);
    } finally {
      setLoading(false);
    }
  }, [A, B, fetchFiveRoutes]);

  const selected = routes.find((r) => r.index === selectedRoute);

  // Маркеры каждые 100 м по ВЫБРАННОМУ маршруту
  const every100mMarkers: RouteMarker[] = useMemo(() => {
    if (!selected) return [];
    const pts = sampleEveryMeters(selected.coords, 100, 400);
    return pts.map((p) => ({
      ...p,
      remainDuration: selected.duration * (p.remainDistance / selected.distance),
    }));
  }, [selected]);

  const resetPoints = () => {
    setA(null); setB(null);
    setLatA(""); setLonA(""); setLatB(""); setLonB("");
    setRoutes([]); setSelectedRoute(0);
    setShowAllRoutes(true);
    setStatusText("Готов к построению"); setStatusKey("idle"); setErrorText(null);
  };

  const setActivePointToMyLocation = () => {
    if (!myLocation) {
      Alert.alert("Геолокация", "Не удалось получить ваше местоположение. Включите доступ к геолокации.");
      return;
    }
    const { latitude, longitude } = myLocation;
    if (activeSetter === "A") {
      setA({ lat: latitude, lon: longitude });
      setLatA(latitude.toFixed(6)); setLonA(longitude.toFixed(6));
    } else {
      setB({ lat: latitude, lon: longitude });
      setLatB(latitude.toFixed(6)); setLonB(longitude.toFixed(6));
    }
  };

  /** ---------- Внешний вид/слои маршрутов ---------- */
  const getRouteAppearance = useCallback((r: RouteView) => {
    const isOpt = r.isPrimary;
    const isSel = r.index === selectedRoute;

    // Показ: если включен режим всех — показываем все, иначе только выбранный
    const shouldShow = showAllRoutes ? true : isSel;

    // Цвет/толщина (двойной штрих)
    const mainColor = isSel ? r.color : isOpt ? r.color : "rgba(255,255,255,0.45)";
    const mainWidth = isSel ? 12 : isOpt ? 10 : 6;
    const outlineColor = isSel ? "rgba(255,255,255,0.98)" : isOpt ? "rgba(255,255,255,0.9)" : "rgba(255,255,255,0.35)";
    const outlineWidth = mainWidth + 4;

    // z-слой: при показе всех — оптимальный всегда сверху
    let z = 0;
    if (showAllRoutes) {
      if (isSel && !isOpt) z = 1;
      if (isOpt) z = 2;
    } else {
      z = 2; // единственный видимый — сверху
    }

    return { mainColor, mainWidth, outlineColor, outlineWidth, shouldShow, z };
  }, [showAllRoutes, selectedRoute]);

  // порядок рисования: от низкого z к высокому
  const routesSorted = useMemo(() => {
    return routes.slice().sort((a, b) => {
      const za = showAllRoutes
        ? (a.isPrimary ? 2 : (a.index === selectedRoute ? 1 : 0))
        : (a.index === selectedRoute ? 2 : 0);
      const zb = showAllRoutes
        ? (b.isPrimary ? 2 : (b.index === selectedRoute ? 1 : 0))
        : (b.index === selectedRoute ? 2 : 0);
      return za - zb;
    });
  }, [routes, selectedRoute, showAllRoutes]);

  // Список видимых маршрутов (для жёсткого ремоунта)
  const visibleRoutes = useMemo(() => {
    return showAllRoutes ? routesSorted : routesSorted.filter((r) => r.index === selectedRoute);
  }, [routesSorted, showAllRoutes, selectedRoute]);

  // При выборе маршрута — оставить только его
  const selectRouteOnly = (idx: number) => {
    setSelectedRoute(idx);
    setShowAllRoutes(false);
    setStatusText(`Выбран маршрут #${idx + 1}`);
  };

  /** ---------- AI (Gemini) — Авто-анализ без ввода ---------- */
  const [autoAiEnabled, setAutoAiEnabled] = useState<boolean>(true);
  const [aiLoading, setAiLoading] = useState<boolean>(false);
  const [aiText, setAiText] = useState<string>("");
  const [aiSuggestedIndex, setAiSuggestedIndex] = useState<number | null>(null);
  const lastAiSignatureRef = useRef<string>("");

  const geminiEndpoint =
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

  // Статистика маршрута
  const routeStats = (r: RouteView) => {
    const turns = r.turnNodes.length;
    const leftTurns = r.turnNodes.filter(t => (t.modifier || "").toLowerCase().includes("left")).length;
    const roundabouts = r.turnNodes.filter(t => t.maneuverType.toLowerCase().includes("кольцев")).length;
    const avgStep = turns ? r.turnNodes.reduce((s, t) => s + t.stepDistance, 0) / turns : 0;
    return {
      index: r.index,
      isPrimary: r.isPrimary,
      distance_m: Math.round(r.distance),
      duration_s: Math.round(r.duration),
      turns,
      left_turns: leftTurns,
      roundabouts,
      avg_step_m: Math.round(avgStep),
    };
  };

  // «Мягкие» предпочтения без ввода пользователя
  const inferPreferences = (all: RouteView[]) => {
    const now = new Date();
    const hour = now.getHours();
    const timeBias =
      (hour >= 22 || hour < 6) ? "ночь: избегать сложных манёвров и кольцевых" :
      (hour >= 7 && hour <= 10) ? "утренний час-пик: приоритет времени" :
      (hour >= 17 && hour <= 20) ? "вечерний час-пик: приоритет времени" :
      "день: баланс времени и удобства";

    const stats = all.map(routeStats);
    const fastest = [...stats].sort((a,b) => a.duration_s - b.duration_s)[0];
    const fewestTurns = [...stats].sort((a,b) => a.turns - b.turns)[0];
    const leastLeft = [...stats].sort((a,b) => a.left_turns - b.left_turns)[0];

    return {
      timeBias,
      hints: [
        `быстрый: индекс ${fastest.index} (${Math.round(fastest.duration_s/60)} мин)`,
        `минимум поворотов: индекс ${fewestTurns.index} (${fewestTurns.turns} поворотов)`,
        `минимум левых: индекс ${leastLeft.index} (${leastLeft.left_turns} левых пов.)`
      ],
      stats
    };
  };

  // Сериализация пакета для LLM
  const serializeForAutoAI = (rs: RouteView[], selectedIndex: number) => {
    const pref = inferPreferences(rs);
    const pack = rs.map(r => ({
      index: r.index,
      isPrimary: r.isPrimary,
      distance_m: Math.round(r.distance),
      duration_s: Math.round(r.duration),
      turns: r.turnNodes.length,
      left_turns: r.turnNodes.filter(t => (t.modifier || "").toLowerCase().includes("left")).length,
      roundabouts: r.turnNodes.filter(t => t.maneuverType.toLowerCase().includes("кольцев")).length,
      sample_turns: r.turnNodes.slice(0, 15).map(t => ({
        m: t.maneuverType, mod: t.modifier || "", street: t.street,
        lat: Number(t.coordinate.latitude.toFixed(6)), lon: Number(t.coordinate.longitude.toFixed(6))
      }))
    }));

    return JSON.stringify({
      context: {
        time_of_day: pref.timeBias,
        derived_hints: pref.hints,
        selected_route_index: selectedIndex
      },
      routes: pack
    });
  };

  const parseSuggestedIndex = (txt: string): number | null => {
    const m1 = txt.match(/route[_\s-]?index\s*=\s*(\d+)/i);
    if (m1) return Number(m1[1]);
    const m2 = txt.match(/маршрут\s*#\s*(\d+)/i);
    if (m2) return Number(m2[1]) - 1;
    return null;
  };

  const routesSignature = (rs: RouteView[]) =>
    rs.map(r => `${r.index}:${Math.round(r.distance)}:${Math.round(r.duration)}:${r.turnNodes.length}`).join("|");

  const callGeminiAuto = async () => {
    if (routes.length === 0) return;
    try {
      setAiLoading(true);
      setAiText("");
      setAiSuggestedIndex(null);

      const sysPrompt =
        "Ты — навигатор. На вход даётся JSON с альтернативными маршрутами и мягкими предпочтениями, " +
        "которые выведены автоматически (пользователь ничего не вводил). " +
        "Задача: 1) кратко сравни (время/дистанция/манёвры/левые повороты/кольцевые), " +
        "2) дай 3–6 пошаговых рекомендаций для выбранного маршрута (лаконично), " +
        "3) назови один конкретный маршрут, оптимальный под контекст времени суток и derived_hints. " +
        "Оформи текст красиво и удобным для чтения. Не используй специальные символы для markdown " +
        "Не задавай вопросов пользователю.";

      const dataJson = serializeForAutoAI(routes, selectedRoute);

      const body = {
        contents: [
          {
            role: "user",
            parts: [
              { text: sysPrompt },
              { text: "Данные маршрутов:\n" + dataJson }
            ]
          }
        ]
      };

      const res = await fetch(`${geminiEndpoint}?key=${process.env.EXPO_PUBLIC_GEMINI_API_KEY}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });

      console.log(res)

      if (!res.ok) {
        const t = await res.text().catch(() => "");
        throw new Error(`${res.status}: ${t || "ошибка запроса"}`);
      }

      const json = await res.json();
      const text =
        json?.candidates?.[0]?.content?.parts?.map((p: any) => p?.text).filter(Boolean).join("\n").trim() ||
        "Не удалось разобрать ответ ИИ.";

      setAiText(text);
      const idx = parseSuggestedIndex(text);
      if (typeof idx === "number" && !Number.isNaN(idx) && idx >= 0 && idx < routes.length) {
        setAiSuggestedIndex(idx);
      }
    } catch (e: any) {
      Alert.alert("AI", e?.message || "Неизвестная ошибка при запросе к ИИ.");
    } finally {
      setAiLoading(false);
    }
  };

  // Автозапуск ИИ при смене набора маршрутов
  useEffect(() => {
    if (!autoAiEnabled || routes.length === 0) return;
    const sig = routesSignature(routes);
    if (sig === lastAiSignatureRef.current) return; // те же маршруты — пропускаем
    lastAiSignatureRef.current = sig;
    setTimeout(() => { callGeminiAuto(); }, 150);
  }, [autoAiEnabled, routes, selectedRoute]); // при перестроении/перевыборе маршрута

  /** ---------- /AI (Gemini) ---------- */

  return (
    <View style={styles.container}>
      <MapView
        ref={mapRef}
        provider={PROVIDER_DEFAULT}
        style={StyleSheet.absoluteFill}
        initialRegion={initialRegion}
        onPress={onMapPress}
        showsUserLocation
        showsMyLocationButton
        onUserLocationChange={handleUserLocation}
      >
        {A && (
          <Marker
            pinColor="#34C759"
            draggable
            onPress={() => {}}
            coordinate={{ latitude: A.lat, longitude: A.lon }}
            title="Точка A"
            description={`${A.lat.toFixed(6)}, ${A.lon.toFixed(6)}`}
            onDragEnd={(e) => setA({ lat: e.nativeEvent.coordinate.latitude, lon: e.nativeEvent.coordinate.longitude })}
          />
        )}
        {B && (
          <Marker
            pinColor="#FF3B30"
            draggable
            onPress={() => {}}
            coordinate={{ latitude: B.lat, longitude: B.lon }}
            title="Точка B"
            description={`${B.lat.toFixed(6)}, ${B.lon.toFixed(6)}`}
            onDragEnd={(e) => setB({ lat: e.nativeEvent.coordinate.latitude, lon: e.nativeEvent.coordinate.longitude })}
          />
        )}

        {/* Контуры (outline) */}
        {visibleRoutes.map((r) => {
          const ap = getRouteAppearance(r);
          if (!ap.shouldShow) return null;
          return (
            <Polyline
              key={`${r.id}-outline-${showAllRoutes ? "all" : "sel"}-${selectedRoute}`}
              coordinates={r.coords}
              strokeColor={ap.outlineColor}
              strokeWidth={ap.outlineWidth}
              zIndex={ap.z}
              tappable
              onPress={() => selectRouteOnly(r.index)}
            />
          );
        })}

        {/* Основные цветные линии */}
        {visibleRoutes.map((r) => {
          const ap = getRouteAppearance(r);
          if (!ap.shouldShow) return null;
          return (
            <Polyline
              key={`${r.id}-main-${showAllRoutes ? "all" : "sel"}-${selectedRoute}`}
              coordinates={r.coords}
              strokeColor={ap.mainColor}
              strokeWidth={ap.mainWidth}
              zIndex={ap.z}
              tappable
              onPress={() => selectRouteOnly(r.index)}
            />
          );
        })}

        {/* Группа выбранного маршрута: узлы + метки 100 м */}
        {selected && (
          <React.Fragment key={`sel-group-${selectedRoute}-${selected.coords.length}`}>
            {showNodes && selected.turnNodes.map((n) => (
              <Marker key={`turn-${selectedRoute}-${n.id}`} coordinate={n.coordinate} onPress={() => {}}>
                <Callout tooltip>
                  <View style={styles.calloutCard}>
                    <Text style={styles.calloutTitle}>{n.maneuverType}</Text>
                    <Text style={styles.calloutText}>{n.street}</Text>
                    <Text style={styles.calloutSub}>
                      {n.coordinate.latitude.toFixed(6)}, {n.coordinate.longitude.toFixed(6)}
                    </Text>
                    <Text style={styles.calloutSub}>Шаг: {fmtDist(n.stepDistance)} · {fmtDur(n.stepDuration)}</Text>
                  </View>
                </Callout>
              </Marker>
            ))}

            {every100mMarkers.map((p) => (
              <Marker key={`m100-${selectedRoute}-${p.id}`} coordinate={p.coordinate} pinColor="#2C2C2E" onPress={() => {}}>
                <Callout tooltip>
                  <View style={styles.infoCard}>
                    <Text style={styles.infoTitle}>Контрольная точка</Text>
                    <Text style={styles.infoText}>
                      Пройдено: {fmtDist(p.coveredDistance)} · Осталось: {fmtDist(p.remainDistance)} (~{fmtDur(p.remainDuration)})
                    </Text>
                    <Text style={styles.infoSub}>
                      {p.coordinate.latitude.toFixed(6)}, {p.coordinate.longitude.toFixed(6)}
                    </Text>
                  </View>
                </Callout>
              </Marker>
            ))}
          </React.Fragment>
        )}
      </MapView>

      {!sheetOpen && (
        <TouchableOpacity style={styles.fab} onPress={() => openSheet()}>
          <Text style={styles.fabText}>Меню</Text>
        </TouchableOpacity>
      )}

      {/* Bottom Sheet */}
      <Animated.View style={[styles.sheet, { height: SHEET_EXPANDED }, sheetStyle]}>
        <View {...panResponder.panHandlers}>
          <View style={styles.grabberWrap}>
            <View style={styles.grabber} />
          </View>
        </View>

        <View style={styles.rowBetween}>
          <View
            style={[
              styles.statusPill,
              { backgroundColor: statusColors[statusKey].bg }
            ]}
          >
            <View style={[styles.statusDot, { backgroundColor: statusColors[statusKey].dot }]} />
            <Text style={[styles.statusText, { color: statusColors[statusKey].text }]}>{statusText}</Text>
          </View>
          <TouchableOpacity onPress={() => closeSheet()} style={styles.hideBtn}>
            <Text style={styles.hideBtnText}>Свернуть</Text>
          </TouchableOpacity>
        </View>

        <FlatList
          data={[{ key: "controls" }]}
          keyExtractor={(i) => i.key}
          renderItem={() => (
            <View>
              {/* Выбор точки + моё местоположение */}
              <View style={[styles.vStack, { marginTop: 4 }]}>
                <Text style={styles.sectionTitle}>Выбор точки</Text>
                <View style={styles.segmentRow}>
                  <TouchableOpacity
                    style={[styles.pointBtn, activeSetter === "A" && styles.pointBtnActiveA]}
                    onPress={() => setActiveSetter("A")}
                  >
                    <Text style={[styles.pointBtnText, activeSetter === "A" && styles.pointBtnTextActiveDark]}>
                      Ставить A
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.pointBtn, activeSetter === "B" && styles.pointBtnActiveB]}
                    onPress={() => setActiveSetter("B")}
                  >
                    <Text style={[styles.pointBtnText, activeSetter === "B" && styles.pointBtnTextActiveDark]}>
                      Ставить B
                    </Text>
                  </TouchableOpacity>
                </View>

                <TouchableOpacity style={[styles.segmentBtn, styles.myLocBtn]} onPress={setActivePointToMyLocation}>
                  <Text style={[styles.segmentText, styles.myLocText]}>Поставить по моему местоположению</Text>
                </TouchableOpacity>
              </View>

              {/* Координаты */}
              <View style={[styles.vStack, { marginTop: 12 }]}>
                <Text style={styles.sectionTitle}>Координаты</Text>

                <View style={styles.coordsRow}>
                  <Text style={styles.label}>A</Text>
                  <TextInput
                    style={styles.input}
                    value={latA}
                    keyboardType="numeric"
                    onChangeText={(t) => { setLatA(t); onChangeCoordInput((c) => setA(c), t, lonA); }}
                    placeholder="Широта" placeholderTextColor={SUBTLE}
                  />
                  <TextInput
                    style={styles.input}
                    value={lonA}
                    keyboardType="numeric"
                    onChangeText={(t) => { setLonA(t); onChangeCoordInput((c) => setA(c), latA, t); }}
                    placeholder="Долгота" placeholderTextColor={SUBTLE}
                  />
                </View>

                <View style={styles.coordsRow}>
                  <Text style={styles.label}>B</Text>
                  <TextInput
                    style={styles.input}
                    value={latB}
                    keyboardType="numeric"
                    onChangeText={(t) => { setLatB(t); onChangeCoordInput((c) => setB(c), t, lonB); }}
                    placeholder="Широта" placeholderTextColor={SUBTLE}
                  />
                  <TextInput
                    style={styles.input}
                    value={lonB}
                    keyboardType="numeric"
                    onChangeText={(t) => { setLonB(t); onChangeCoordInput((c) => setB(c), latB, t); }}
                    placeholder="Долгота" placeholderTextColor={SUBTLE}
                  />
                </View>
              </View>

              {/* Действия */}
              <View style={[styles.vStack, { marginTop: 12 }]}>
                <Text style={styles.sectionTitle}>Действия</Text>
                <TouchableOpacity
                  style={[styles.primaryBtn, (!(A && B) || loading) && styles.primaryBtnDisabled]}
                  onPress={fetchRoutes}
                  disabled={!(A && B) || loading}
                >
                  {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryBtnText}>Построить маршруты (до 5)</Text>}
                </TouchableOpacity>

                {/* Переключатель: все маршруты / только выбранный */}
                <TouchableOpacity
                  style={[styles.secondaryBtn, showAllRoutes && styles.secondaryBtnActive]}
                  onPress={() => setShowAllRoutes((v) => !v)}
                >
                  <Text style={[styles.secondaryBtnText, showAllRoutes && styles.secondaryBtnTextActive]}>
                    {showAllRoutes ? "Все маршруты: вкл." : "Все маршруты: выкл. (только выбранный)"}
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity style={styles.ghostBtn} onPress={resetPoints}>
                  <Text style={styles.ghostBtnText}>Сбросить точки</Text>
                </TouchableOpacity>
              </View>

              {/* Ошибка и список маршрутов */}
              {errorText ? <Text style={styles.errorText}>{errorText}</Text> : null}

              <View style={{ marginTop: 8, paddingBottom: 8 }}>
                {routes.length > 0 && (
                  <Text style={styles.routesHeaderText}>
                    Найдено маршрутов: {routes.length}. Оптимальный — сверху при показе всех.
                  </Text>
                )}
                <FlatList
                  data={routes}
                  keyExtractor={(r) => r.id}
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={{ paddingVertical: 6 }}
                  renderItem={({ item }) => (
                    <TouchableOpacity
                      style={[styles.routeCard, selectedRoute === item.index && styles.routeCardActive]}
                      onPress={() => selectRouteOnly(item.index)}
                    >
                      <View style={[styles.colorDot, { backgroundColor: item.color }]} />
                      <View style={{ flex: 1 }}>
                        <Text style={styles.routeTitle}>
                          {item.isPrimary ? "Оптимальный маршрут" : `Альтернатива ${item.index + 1}`}
                        </Text>
                        <Text style={styles.routeMeta}>{fmtDur(item.duration)} · {fmtDist(item.distance)}</Text>
                      </View>
                      <Text style={styles.chevron}>›</Text>
                    </TouchableOpacity>
                  )}
                />
              </View>

              {/* === Auto AI (Gemini) — без ввода === */}
              <View style={[styles.vStack, { marginTop: 12, paddingBottom: 16 }]}>
                <Text style={styles.sectionTitle}>ИИ помощник маршрута</Text>

                <TouchableOpacity
                  style={[styles.secondaryBtn, autoAiEnabled && styles.secondaryBtnActive]}
                  onPress={() => setAutoAiEnabled(v => !v)}
                >
                  <Text style={[styles.secondaryBtnText, autoAiEnabled && styles.secondaryBtnTextActive]}>
                    Авто-анализ ИИ: {autoAiEnabled ? "вкл." : "выкл."}
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[styles.primaryBtn, (routes.length === 0 || aiLoading) && styles.primaryBtnDisabled]}
                  onPress={callGeminiAuto}
                  disabled={routes.length === 0 || aiLoading}
                >
                  {aiLoading ? <ActivityIndicator color="#fff" /> :
                    <Text style={styles.primaryBtnText}>Запустить анализ сейчас</Text>}
                </TouchableOpacity>

                {aiLoading && <ActivityIndicator color="#fff" style={{ marginTop: 10 }} />}
{aiText ? (
  <View style={{ backgroundColor: "rgba(255,255,255,0.08)", margin: 12, padding: 12, borderRadius: 10 }}>
    <Text style={{ color: "#EDEDED", fontWeight: "600", fontSize: 14, lineHeight: 20 }}>
      {aiText}
    </Text>
  </View>
) : null}
              </View>
              {/* === /Auto AI (Gemini) === */}
            </View>
          )}
        />
      </Animated.View>
    </View>
  );
}

/** ---------- Styles ---------- */
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0F0F10" },

  fab: {
    position: "absolute",
    bottom: 22,
    alignSelf: "center",
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 16,
    backgroundColor: TINT,
    shadowColor: "#000",
    shadowOpacity: 0.25,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  fabText: { color: "#fff", fontWeight: "800", letterSpacing: 0.2 },

  sheet: {
    position: "absolute",
    left: 0, right: 0, bottom: 0,
    backgroundColor: SURFACE,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    borderTopWidth: 1,
    borderColor: STROKE,
  },
  grabberWrap: { alignItems: "center", paddingVertical: 8 },
  grabber: { width: 44, height: 5, borderRadius: 3, backgroundColor: "rgba(255,255,255,0.25)" },

  rowBetween: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: 12 },

  statusPill: {
    flexDirection: "row", alignItems: "center", gap: 8,
    alignSelf: "flex-start", paddingHorizontal: 10, paddingVertical: 6,
    borderRadius: 12, marginTop: 2, marginBottom: 6,
  },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  statusText: { fontSize: 12 },

  hideBtn: { paddingHorizontal: 10, paddingVertical: 8, borderRadius: 10 },
  hideBtnText: { color: "#FFD1CF", fontWeight: "700" },

  vStack: { gap: 8, paddingHorizontal: 12 },
  sectionTitle: { color: "#EDEDED", fontWeight: "800", marginBottom: 2 },

  segmentRow: { flexDirection: "row", gap: 8 },
  pointBtn: {
    flex: 1, paddingVertical: 12, borderRadius: 12,
    backgroundColor: "rgba(255,255,255,0.06)", borderWidth: 1, borderColor: STROKE, alignItems: "center",
  },
  pointBtnActiveA: { backgroundColor: "#34C759", borderColor: "#34C759" },
  pointBtnActiveB: { backgroundColor: "#FF3B30", borderColor: "#FF3B30" },
  pointBtnText: { color: TEXT, fontWeight: "700" },
  pointBtnTextActiveDark: { color: "#111", fontWeight: "800" },

  segmentBtn: { paddingHorizontal: 12, paddingVertical: 12, borderRadius: 10, backgroundColor: "rgba(255,255,255,0.06)" },
  segmentText: { color: TEXT, fontWeight: "600" },
  myLocBtn: { marginTop: 6, backgroundColor: "rgba(52,199,89,0.18)" },
  myLocText: { color: "#CFF9D5", fontWeight: "700" },

  coordsRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  label: {
    width: 18, textAlign: "center", color: SUBTLE, fontWeight: "800",
    backgroundColor: "rgba(255,255,255,0.06)", paddingVertical: 9, borderRadius: 10,
  },
  input: {
    minWidth: 92, flexGrow: 1, height: 40, paddingHorizontal: 12, borderRadius: 10,
    backgroundColor: "rgba(255,255,255,0.06)", color: TEXT, borderWidth: 1, borderColor: STROKE,
  },

  primaryBtn: { backgroundColor: TINT, borderRadius: 12, paddingVertical: 14, alignItems: "center" },
  primaryBtnDisabled: { opacity: 0.5 },
  primaryBtnText: { color: "#fff", fontWeight: "800", letterSpacing: 0.2 },

  secondaryBtn: {
    marginTop: 8,
    paddingVertical: 14, paddingHorizontal: 14,
    borderRadius: 12, backgroundColor: "rgba(10,132,255,0.16)",
    borderWidth: 1, borderColor: "rgba(10,132,255,0.25)", alignItems: "center",
  },
  secondaryBtnActive: { backgroundColor: "#FFFFFF", borderColor: "#FFFFFF" },
  secondaryBtnText: { color: "#C7E1FF", fontWeight: "700" },
  secondaryBtnTextActive: { color: "#111", fontWeight: "800" },

  ghostBtn: {
    marginTop: 8, paddingVertical: 14, paddingHorizontal: 14,
    borderRadius: 12, borderWidth: 1, borderColor: "rgba(255,255,255,0.25)", alignItems: "center",
  },
  ghostBtnText: { color: "#dfe6e9", fontWeight: "700" },

  errorText: { color: "#FF453A", marginTop: 8, paddingHorizontal: 12 },

  routesHeaderText: { color: SUBTLE, paddingHorizontal: 12 },

  routeCard: {
    width: 220, flexDirection: "row", alignItems: "center", gap: 10,
    backgroundColor: "rgba(255,255,255,0.06)", paddingVertical: 12, paddingHorizontal: 14,
    marginRight: 8, borderRadius: 14, borderWidth: 1, borderColor: STROKE,
  },
  routeCardActive: { borderColor: "#FFFFFF", backgroundColor: "rgba(255,255,255,0.12)" },
  colorDot: { width: 12, height: 12, borderRadius: 6, marginTop: 2 },
  routeTitle: { color: TEXT, fontWeight: "800" },
  routeMeta: { color: SUBTLE, marginTop: 2 },
  chevron: { color: SUBTLE, fontSize: 22, paddingHorizontal: 4, paddingTop: 2 },

  calloutCard: {
    paddingVertical: 8, paddingHorizontal: 10, backgroundColor: "#fff",
    borderRadius: 12, borderColor: "#eaeaea", borderWidth: 1, maxWidth: 240,
  },
  calloutTitle: { fontWeight: "800", marginBottom: 2, color: "#111" },
  calloutText: { color: "#222" },
  calloutSub: { color: "#6B6B6B", fontSize: 12, marginTop: 2 },

  infoCard: {
    paddingVertical: 8, paddingHorizontal: 10, backgroundColor: "#fff",
    borderRadius: 12, borderColor: "#eaeaea", borderWidth: 1, maxWidth: 240,
  },
  infoTitle: { fontWeight: "800", marginBottom: 2, color: "#111" },
  infoText: { color: "#222" },
  infoSub: { color: "#6B6B6B", fontSize: 12, marginTop: 2 },

  // === AI (Gemini) ===
  aiCard: {
    marginTop: 8,
    backgroundColor: "rgba(255,255,255,0.06)",
    borderColor: STROKE,
    borderWidth: 1,
    borderRadius: 14,
    padding: 12
  },
  aiTitle: { color: "#EDEDED", fontWeight: "800", marginBottom: 6 },
  aiText: { color: "#EDEDED" },
  applyBtn: { marginTop: 8 }
});
