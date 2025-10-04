# 📍 Graph Routing on Map — React Native + Expo

Короткий и практичный README для приложения, которое строит граф на карте, находит кратчайший путь (Dijkstra) и рисует несколько альтернативных маршрутов поверх OpenStreetMap в **React Native (Expo)** без Google SDK.

---

## ✨ Возможности

* Построение **графа дорог** из данных OSRM (или собственного источника)
* **Несколько альтернативных маршрутов**: самый оптимальный поверх всех, остальные полупрозрачные
* **Переключение активного маршрута** (цвет и z-index меняются, лишние слои скрываются)
* **Маркеры через каждые 100 м** на выбранном маршруте
* Поддержка **Expo Go / EAS Build**, **TypeScript**, **без нативных модулей и WebView**

---

## 🧱 Технологии

* **Expo** (SDK 51+) / React Native
* **react-native-maps** с **OpenStreetMap**
* **TypeScript**
* **OSRM** (public или self-hosted) для получения shape/узлов
* Алгоритмы: **Dijkstra**

---

## 📦 Установка и запуск

```bash
# 1) Клонирование
git clone <your-repo-url>
cd <your-app>

# 2) Установка зависимостей
pnpm i      # или npm i / yarn

# 3) Запуск в dev
pnpm expo start
# сканируйте QR код в Expo Go или запустите эмулятор
```

> Требования: Node 18+, pnpm|npm|yarn, Android Studio или Xcode (для эмуляторов).

---