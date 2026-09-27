# Localisation

**Lightkeeper ships in every language Homey supports: English, Dutch, German,
French, Italian, Swedish, Norwegian, Spanish, Danish, Russian, Polish, Korean
and Arabic.** The list is `test/support/languages.ts`, and it is Homey's own —
exactly the set the pinned CLI's `homey app translate` offers.

| Code | Language | Plural forms (`Intl.PluralRules`) | Ordinal forms | Reads |
|---|---|---|---|---|
| `en` | English | one, other | one, two, few, other | ltr |
| `nl` | Dutch | one, other | other | ltr |
| `de` | German | one, other | other | ltr |
| `fr` | French | one, many, other | one, other | ltr |
| `it` | Italian | one, many, other | many, other | ltr |
| `sv` | Swedish | one, other | one, other | ltr |
| `no` | Norwegian | one, other | other | ltr |
| `es` | Spanish | one, many, other | other | ltr |
| `da` | Danish | one, other | other | ltr |
| `ru` | Russian | one, few, many, other | other | ltr |
| `pl` | Polish | one, few, many, other | other | ltr |
| `ko` | Korean | other | other | ltr |
| `ar` | Arabic | zero, one, two, few, many, other | other | **rtl** |

The plural columns are not ours to choose: they are what Node's
`Intl.PluralRules` reports, and `test/unit/locales.test.ts` holds every locale
file to exactly that set. `many` in French, Italian and Spanish is the
"de millions" form and is usually the same text as `other`.

## The rule

**Every new or changed user-facing string lands in all thirteen languages in
the same change.** Not in a follow-up, not "English now, the rest later": a
missing key is a test failure, and a string changed in English but not
elsewhere is a screen that says two different things depending on who is
reading it. Change `en.json`, then change the same key in the other twelve.

That covers, every time:

1. **`locales/<lang>.json`**, all thirteen — same keys, same `__tokens__`.
2. **Every `{ "en": … }` object in a manifest** — `.homeycompose/app.json`
   (name, description, tags), `.homeycompose/capabilities/*.json`,
   `.homeycompose/flow/actions/*.json`, every `drivers/*/driver.compose.json`
   and `drivers/daylight/driver.flow.compose.json`. `manifest-locales.test.ts`
   fails on any object missing a language, and on a `titleFormatted` whose
   `[[arg]]`s differ from English.
3. **The release's `.homeychangelog.json` entry**, in all thirteen.
4. **`README.<lang>.txt`** — the App Store listing, one per language beside
   `README.txt`. Re-read all of them when what the app *is* changes.

Then `npm run validate` (which regenerates `app.json`) and `npm test`.

## How the machinery works

- `lib/` never translates. It returns a locale key plus tokens (`StateDetail`,
  `LocalisedError`, `labelKey`), and the driver or device layer resolves it.
- **Counted strings are plural groups**, keyed by CLDR category:

  ```json
  "someLights": { "one": "__count__ light", "other": "__count__ lights" }
  ```

  The count is **always the `count` token** — that convention is what lets the
  lookup be automatic. `lib/support/i18n.ts` (driver and device layer) and
  `views/shared/i18n.js` (every pairing screen and the settings page) pick the
  form with `Intl.PluralRules` in the locale file's own language, so a
  `StateDetail` from `lib/` never has to know its key is a group. A form for
  exactly one thing may leave `__count__` out ("Test my light"); `other` may
  not. **Never write `(s)`** and never pick a key with `count === 1 ? …` —
  both were how English grammar leaked into every other language.
- **The language comes from the locale file**, `meta.language`, not from
  `homey.i18n.getLanguage()`: a Homey set to a language we do not ship reads
  `en.json`, and must then choose English plural forms. `meta.direction` is
  `rtl` for Arabic, and every screen puts it on its own root element.
- **Ordinals** are `ordinal.{one,two,few,other}` with `__n__` — "1st" in
  English, "1." in German, "1er" in French — chosen by
  `Intl.PluralRules(lang, { type: 'ordinal' })` through `lk.ordinal(n)`.
- **Percentages** go through `unit.percent` (`lk.percent(n)` in a view,
  `tr('unit.percent', { n })` in a driver): French and the Nordic languages put
  a space before the sign. **Lists** join with `unit.listSeparator` (`lk.list`),
  which is `،` in Arabic. **Dates and times** use `lk.dateTime` / `lk.time`, in
  the app's language rather than the phone's.
- **Never assemble a sentence from translated fragments.** Word order is the
  translator's, so a phrase with a variable in it is ONE key with a token —
  `names.suffixed` is `"__place__ __suffix__"` in English and
  `"__suffix__ __place__"` wherever that reads better. Never `.toLowerCase()` a
  translated word either: German nouns are capitalised.
- **Right-to-left**: text flow uses logical CSS (`text-align: start`,
  `padding-inline-end`), which is identical in a left-to-right language and
  mirrors in Arabic. Charts, timelines and sliders keep `left` positioning on
  purpose — a time axis that runs 00:00 to 24:00 left to right is how Homey's
  own graphs draw it in every language.
- Views call **`lk.t()`**, never `Homey.__` — `pair-view-styles.test.ts` fails
  on a direct call, because a direct call skips the plural step. Drivers call
  their own `this.tr()`, which is `translatorFor(this.homey)`.

## What is deliberately English

- **Logs and diagnostics**, including `/diagnostics`, the settings page's raw
  event and write logs, and every `text` field beside a `StateDetail` key.
- **Generated Flow names** — "Lightkeeper — Hall remote: Dial — Turn right",
  "On at 22:00, Mon–Fri". Both are part of a Flow's title in the user's own Flow
  list, and renaming a Flow is exactly what reconciliation treats as the user's
  own edit. The stored gesture label stays English for the same reason;
  `lib/inputs/input-label.ts` translates it on its way to a screen by parsing
  the normalizer's own closed vocabulary back out.
- **Vendor wording** — a remote's own control names ("1 up rotary") and a
  device's own name are whatever the integration and the user wrote.
- **The "could not reach Homey" banner** in the pair views. It fires precisely
  when `window.Homey` never arrives, so `Homey.__` does not exist at that
  moment. The failure mode *is* the absence of the translator.

## Glossary

The term choices, so that every screen in a language calls the same thing the
same name. Where Homey's own app has a term, it wins — Homey's words are what
the user already reads everywhere else. **Never translated:** Lightkeeper,
Homey, Flow (capital F, in every language), Zigbee, Matter, Philips Hue, IKEA,
lx, K.

**Register.** Homey addresses the user informally in the Germanic languages
and Italian (du / je / tu), and formally in French and Russian (vous / вы).
Spanish uses tú. Polish uses the informal second person but prefers impersonal
phrasing where it reads naturally. Korean uses the polite 해요체 (-세요). Arabic
is Modern Standard, addressing the user in the masculine singular as Homey does.

| English | nl | de | fr | it | sv |
|---|---|---|---|---|---|
| Light Remote | Lichtafstandsbediening | Licht-Fernbedienung | Télécommande d'éclairage | Telecomando luci | Ljusfjärrkontroll |
| circadian light | circadiaans licht | zirkadianes Licht | éclairage circadien | luce circadiana | dygnsrytmsljus |
| Colour Curve Light | Kleurcurvelicht | Farbkurvenlicht | Éclairage à courbe de couleur | Luce a curva di colore | Färgkurvljus |
| Room-sensing Light | Ruimtebewust licht | Raumsensitives Licht | Éclairage selon la pièce | Luce sensibile all'ambiente | Rumskännande ljus |
| light schedule | lichtschema | Lichtzeitplan | programme d'éclairage | programmazione luci | ljusschema |
| remote | afstandsbediening | Fernbedienung | télécommande | telecomando | fjärrkontroll |
| switch | schakelaar | Schalter | interrupteur | interruttore | strömbrytare |
| dial | draaiknop | Drehregler | molette | manopola | vridratt |
| button | knop | Taste | bouton | pulsante | knapp |
| light (a lamp) | lamp | Licht / Leuchte | lumière | luce | lampa |
| room | kamer | Raum | pièce | stanza | rum |
| zone | zone | Zone | zone | zona | zon |
| device | apparaat | Gerät | appareil | dispositivo | enhet |
| brightness | helderheid | Helligkeit | luminosité | luminosità | ljusstyrka |
| colour temperature | kleurtemperatuur | Farbtemperatur | température de couleur | temperatura colore | färgtemperatur |
| warmth / warm / cool | warmte / warm / koel | Wärme / warm / kühl | chaleur / chaud / froid | calore / calda / fredda | värme / varm / kall |
| schedule (a block of it) | schema (blok) | Zeitplan (Block) | programme (plage) | programmazione (fascia) | schema (block) |
| mapping | toewijzing | Zuordnung | association | assegnazione | tilldelning |
| sensor | sensor | Sensor | capteur | sensore | sensor |
| Personal API Key | persoonlijke API-sleutel | persönlicher API-Schlüssel | clé API personnelle | chiave API personale | personlig API-nyckel |
| Repair | Repareren | Reparieren | Réparer | Ripara | Reparera |
| unavailable | niet beschikbaar | nicht verfügbar | indisponible | non disponibile | inte tillgänglig |
| Gradual / Balanced / Quick | Geleidelijk / Gebalanceerd / Snel | Allmählich / Ausgewogen / Schnell | Progressive / Équilibrée / Rapide | Graduale / Bilanciata / Rapida | Gradvis / Balanserad / Snabb |

| English | no | es | da | ru | pl |
|---|---|---|---|---|---|
| Light Remote | Lysfjernkontroll | Mando de luces | Lysfjernbetjening | Пульт освещения | Pilot oświetlenia |
| circadian light | døgnrytmelys | luz circadiana | døgnrytmelys | циркадный свет | światło okołodobowe |
| Colour Curve Light | Fargekurvelys | Luz con curva de color | Farvekurvelys | Свет по цветовой кривой | Światło z krzywą barw |
| Room-sensing Light | Romfølende lys | Luz que percibe la habitación | Rumfølende lys | Свет по освещённости комнаты | Światło czujące pomieszczenie |
| light schedule | lystidsplan | horario de luces | lystidsplan | расписание освещения | harmonogram oświetlenia |
| remote | fjernkontroll | mando | fjernbetjening | пульт | pilot |
| switch | bryter | interruptor | kontakt | выключатель | włącznik |
| dial | dreieknapp | rueda | drejeknap | поворотный регулятор | pokrętło |
| button | knapp | botón | knap | кнопка | przycisk |
| light (a lamp) | lys / lampe | luz | lys / lampe | светильник / свет | światło / lampa |
| room | rom | habitación | rum | комната | pomieszczenie |
| zone | sone | zona | zone | зона | strefa |
| device | enhet | dispositivo | enhed | устройство | urządzenie |
| brightness | lysstyrke | brillo | lysstyrke | яркость | jasność |
| colour temperature | fargetemperatur | temperatura de color | farvetemperatur | цветовая температура | temperatura barwowa |
| warmth / warm / cool | varme / varm / kald | calidez / cálida / fría | varme / varm / kold | теплота / тёплый / холодный | ciepło / ciepłe / chłodne |
| schedule (a block of it) | tidsplan (blokk) | horario (franja) | tidsplan (blok) | расписание (интервал) | harmonogram (blok) |
| mapping | tilordning | asignación | tildeling | назначение | przypisanie |
| sensor | sensor | sensor | sensor | датчик | czujnik |
| Personal API Key | personlig API-nøkkel | clave API personal | personlig API-nøgle | личный API-ключ | osobisty klucz API |
| Repair | Reparer | Reparar | Reparér | Восстановить | Napraw |
| unavailable | utilgjengelig | no disponible | utilgængelig | недоступно | niedostępne |
| Gradual / Balanced / Quick | Gradvis / Balansert / Rask | Gradual / Equilibrada / Rápida | Gradvis / Balanceret / Hurtig | Плавный / Сбалансированный / Быстрый | Stopniowe / Zrównoważone / Szybkie |

| English | ko | ar |
|---|---|---|
| Light Remote | 조명 리모컨 | جهاز التحكم بالإضاءة |
| circadian light | 생체리듬 조명 | إضاءة الإيقاع اليومي |
| Colour Curve Light | 색상 곡선 조명 | إضاءة منحنى الألوان |
| Room-sensing Light | 실내 감지 조명 | إضاءة تستشعر الغرفة |
| light schedule | 조명 일정 | جدول الإضاءة |
| remote | 리모컨 | جهاز التحكم عن بُعد |
| switch | 스위치 | مفتاح الإضاءة |
| dial | 다이얼 | قرص دوّار |
| button | 버튼 | زر |
| light (a lamp) | 조명 | ضوء / مصباح |
| room | 방 | غرفة |
| zone | 구역 | منطقة |
| device | 기기 | جهاز |
| brightness | 밝기 | السطوع |
| colour temperature | 색온도 | درجة حرارة اللون |
| warmth / warm / cool | 따뜻함 / 따뜻한 / 차가운 | الدفء / دافئ / بارد |
| schedule (a block of it) | 일정 (구간) | جدول (فترة) |
| mapping | 할당 | تعيين |
| sensor | 센서 | مستشعر |
| Personal API Key | 개인 API 키 | مفتاح API الشخصي |
| Repair | 복구 | إصلاح |
| unavailable | 사용할 수 없음 | غير متاح |
| Gradual / Balanced / Quick | 천천히 / 균형 / 빠르게 | تدريجي / متوازن / سريع |

**Two traps worth naming.** "Controller" must not be translated as a
hardware-controller word in any language — it is the virtual Light Remote, and
the Danish glossary kept from 0.1.0 made the same point with *betjening*.
And in Arabic, `مفتاح` means both "key" and "switch": the API key is always
`مفتاح API`, a wall switch always `مفتاح الإضاءة`.
