# Sales taxes (Philippines)

Not tax advice. This is how the POS applies the rules; the owner confirms the
setup with their accountant.

## The rules the POS follows

| Situation | What applies | Where |
|---|---|---|
| Gross sales up to ₱3,000,000 a year and not VAT-registered | 3% percentage tax on gross quarterly sales; no VAT on prices or receipts | Tax Code Sec. 116, Sec. 109(BB); BIR Form 2551Q |
| VAT-registered (required above ₱3,000,000) | 12% VAT, included in shelf prices of VATable items | Tax Code Sec. 106; BIR Form 2550Q |
| Fresh meat, poultry, fish, eggs, vegetables "in their original state" | VAT-exempt, even if chilled, frozen, salted, dried, smoked, broiled or roasted for the market | Tax Code Sec. 109(A); RR 16-2005 Sec. 4.109-1(B)(1)(a) |
| Condiments, sauces, side dishes, cooked food, drinks, supplies | VATable 12% | Not in the exempt list |
| Processed meats with added ingredients (longganisa, tocino, hotdogs, marinated cuts) | Usually VATable; gray area | Ask the accountant |

VAT invoices and receipts (RR 7-2024 under the Ease of Paying Taxes Act) show
the seller's TIN and VAT status and split VATable sales, VAT, VAT-exempt and
zero-rated sales. Official BIR receipts from a POS also need the POS itself
registered with the BIR (permit to use); until then receipts stay marked
"Non-fiscal test receipt".

## How it works in the app

- **Back Office → Taxes** (owner only): VAT-registered or not, TIN, registered
  name and address, rates, VATable/exempt per category and per product.
  Saved in the cloud (`settings.data -> 'tax'`, `save_tax_settings`).
  Categories not yet saved start from a guess based on their name
  (`guessCategoryClass` in `src/domain/tax.ts`).
- **Devices** download the setup on every sync (`store_tax_settings`) and
  keep it offline. Until it is set, every sale is non-VAT.
- **Each sale** records the tax mode and each line's class; a VAT-registered
  sale also records VATable sales (without VAT), VAT and VAT-exempt sales.
  VAT is worked out once on the VATable total (amount × 12 / 112) and spread
  over the lines so they add up exactly (`computeTax`).
- **Receipts** for VAT sales print "VAT REG TIN", mark lines V or E, and show
  the VAT breakdown. Non-VAT receipts print "NON-VAT REGISTERED" and the TIN.
- **Tax report** (Back Office → Taxes): by quarter or month, gross sales,
  non-VAT sales with the percentage tax due, VATable sales, VAT and exempt
  sales, by category too, with a CSV download.

Other features (for example invoices to business customers) reuse
`src/domain/tax.ts`: `productClass`, `computeTax`, `vatInInclusive` and the
`TaxSettings` downloaded to each device (`getTaxSettings`).
