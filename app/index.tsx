import React from "react";
import { StatusBar, StyleSheet, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import Map from "@/component/Map";
import BottomSheet from "@gorhom/bottom-sheet";
import BottomSheetComponent from "@/component/BottomSheetComponent";

export default function Index() {
  return (
    <GestureHandlerRootView>
      <View
        style={styles.container}
      >
        <StatusBar barStyle="light-content" />
        <Map />
        <BottomSheetComponent />
      </View>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: "space-between",
    alignItems: "center"
  }
})
