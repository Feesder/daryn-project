import { COLORS } from "@/constants/colors";
import BottomSheet, { BottomSheetView } from "@gorhom/bottom-sheet";
import { useMemo, useRef } from "react";
import { Text, StyleSheet } from "react-native"

export default function BottomSheetComponent() {
    const sheetRef = useRef<BottomSheet>(null);
    
    const snapPoints = useMemo(() => ["50%", "95%"], [])
    
    return (
        <BottomSheet
            ref={sheetRef}
            snapPoints={snapPoints}
            backgroundStyle={{ ...styles.bottomSheet }}
            handleIndicatorStyle={{ ...styles.handleIndicatorStyle }}
        >
            <BottomSheetView style={styles.bottomSheetContainer}>
                <Text style={styles.bottomSheetTitle}>Hello world</Text>
                <Text style={styles.bottomSheetTitle}>Hello world</Text>
                <Text style={styles.bottomSheetTitle}>Hello world</Text>
                <Text style={styles.bottomSheetTitle}>Hello world</Text>
                <Text style={styles.bottomSheetTitle}>Hello world</Text>
                <Text style={styles.bottomSheetTitle}>Hello world</Text>
                <Text style={styles.bottomSheetTitle}>Hello world</Text>
            </BottomSheetView>
        </BottomSheet>
    )
}

const styles = StyleSheet.create({
  bottomSheetTitle: {
    fontSize: 20,
    fontWeight: 600,
    color: COLORS.FONT_COLOR
  },
  bottomSheetContainer: {
    paddingHorizontal: 20,
  },
  bottomSheet: {
    backgroundColor: COLORS.PRIMARY_BACKGROUND_COLOR,
  },
  handleIndicatorStyle: {
    width: 45,
    height: 6,
    transform: [{ translateY: -4 }],
    backgroundColor: COLORS.SECONDARY_COLOR
  }
})