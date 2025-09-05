import { View } from "react-native";
import { WebView } from "react-native-webview";

export default function Map() {
    const html = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8" />
        <script src="https://api-maps.yandex.ru/v3/?apikey=291062db-de01-4eb9-b0d2-d44596067922&lang=ru_RU"></script>
        <style>
          html, body, #map {
            padding: 0;
            margin: 0;
            width: 100%;
            height: 100%;
          }
        </style>
      </head>
      <body>
        <div id="map"></div>
      </body>
      <script>
          async function initMap() {
            await ymaps3.ready;

            const {YMap, YMapDefaultSchemeLayer} = ymaps3;

            const map = new YMap(
                    document.getElementById('map'),
                    {
                    location: {
                        center: [78.371295, 45.016879],
                        zoom: 17
                    },
                    theme: "dark"
                }
            );

            map.addChild(new YMapDefaultSchemeLayer());
        }

        initMap();
        </script>
    </html>
  `;

    return (
        <View style={{width: "100%", height: "100%"}}>
            <WebView originWhitelist={["*"]} scrollEnabled={false} source={{ html }} style={{ flex: 1 }} />
        </View>
    )
}