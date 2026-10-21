# Receipt printer (PT-210, 58 mm)

## Status

| Item | Status |
|---|---|
| Receipt renderer (32 columns, word wrap, discounts, NON-FISCAL header) | ✅ implemented and unit tested |
| Browser print adapter (system print dialog, 58 mm print CSS) | ✅ implemented |
| Reprint without creating a sale; print count + audit | ✅ implemented and tested |
| Direct PT-210 printing (Bluetooth / USB) | ❌ **not implemented, not verified** |

**No claim is made that the PT-210 works directly with this app.** It has not been tested with the
physical printer.

## Why direct printing needs the real device

"PT-210" printers are sold under several brands. Most use **Bluetooth Classic (SPP)**. Chrome's
**Web Bluetooth only supports Bluetooth Low Energy**, so a Classic-only printer cannot be reached from
the web app directly. Some units also expose BLE; some accept ESC/POS, some need a vendor protocol.

## Test plan for the owner's printer (do early)

1. Note the exact label/model, and pair it with the Android device.
2. Print a test page from a known app (e.g. RawBT or the vendor app) to confirm paper width and
   characters per line (expect 32 in the default font, 384 dots).
3. In Chrome on Android, open `chrome://bluetooth-internals` → Devices → scan, and check whether the
   printer advertises as a **BLE** device with a writable characteristic.
4. Try printing from the POS with **Print receipt** → Android system print (works only if an Android
   print service supports the printer).
5. Record results here.

## Adapter options (decide after testing)

| Option | When | Notes |
|---|---|---|
| Browser print dialog | Works now | Needs an Android print service for the printer |
| Web Bluetooth BLE + ESC/POS | Printer exposes BLE | Pure web; needs a user tap to connect |
| RawBT-style intent / share | Classic only | Hand ESC/POS bytes to a helper app installed on the device |
| Native Android wrapper (TWA/Capacitor) with SPP | Classic only, best reliability | Adds an Android build |
| WebUSB | USB cable to a computer/tablet with OTG | Chrome desktop/Android support varies |

All adapters implement `PrinterAdapter` (`src/lib/printer/adapter.ts`) and receive the same text lines
from `renderReceipt()`. A sale is always saved before printing; a failed print never affects the sale.
