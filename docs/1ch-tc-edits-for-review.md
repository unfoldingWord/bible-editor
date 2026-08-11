# 1 Chronicles ULT — 33 translationCore edits that need a human decision

**Status:** awaiting review by Chris Smith (`christopherrsmith`) or the 1 Chronicles checker.
**Prepared:** 2026-08-11. Read-only analysis; nothing in the database or on Door43 has been changed as a result of it.

---

## What happened, in plain English

On 10 August 2026, Chris Smith pushed a fresh export of 1 Chronicles ULT from translationCore (the desktop checking tool, "tC") to Door43 — commit `5905373879`. That night, our automatic export from Bible Editor ran and wrote its own version of the same file over the top of his, because the nightly job treats the editor's database as the authority for any verse a translator has touched. In 184 verses the two files disagreed. We went through all 184 one at a time and compared each one against every earlier version of the file on Door43, which tells us whether a given wording is *new work* or simply an *old wording coming back*.

For 151 of the 184, the difference traces back to his tC project holding an older copy of the book rather than to any new decision, so we deliberately did **not** restore them — doing so would have silently undone checking work done since June. Broken down: 129 of them reproduce text that was on Door43 before 17 June 2026 and was later changed in Bible Editor; in another 18 the Bible Editor row was demonstrably the later edit of the two; and 4 differ only in where the lines happen to wrap in the file, which changes nothing a reader sees.

The 33 verses in this document are the ones that are genuinely different. For each of these, his wording appears in **no** earlier version of the file on Door43, which means he typed it in translationCore — it is real new work, and our export threw it away. These are translation and punctuation judgments, not data corruption, so we are not going to bulk-restore them behind anyone's back. **What we need from the reviewer: for each of the 33, decide whether his wording should be put back, or whether the wording now on Door43 should stand.** Once decided, the accepted ones can be entered in Bible Editor (which is what the nightly export publishes) rather than pushed to Door43 directly, so they will not be overwritten again.

Every one of these 33 verses was last edited in Bible Editor by **Carolyn1970**, so accepting his wording means changing her work — which is exactly why this is a conversation and not a script.

---

## How to read each entry

- **His version** — the verse as it reads in his translationCore export (commit `5905373879`). The alignment markup has been stripped out so it reads as ordinary prose.
- **Current version** — the same verse as it reads on Door43 `master` right now, which is what Bible Editor published.
- **Level** — *Wording* means at least one word differs. *Punctuation only* means the letters are identical and only marks differ.
- Curly braces, as in `{was}`, are the ULT's own convention for a word supplied in English that has no separate word behind it in the Hebrew. They are in the real file, not something this report added.
- One pre-existing oddity you will notice in 7:8: `[were}` with a mismatched bracket. That typo is in **both** files and is not one of the differences under review — but somebody may want to fix it separately.

---

## Summary table — triage before you read the detail

| # | Ref | Level | What his version does |
|---|-----|-------|----------------------|
| 1 | 1CH 2:42 | Wording | `Mareshah` → `Mesha` as Caleb's firstborn, plus comma and semicolon changes |
| 2 | 1CH 3:2 | Wording | `Maacah` → `Maakah`; two list commas → semicolons |
| 3 | 1CH 3:5 | Wording | `Bath Shua` → `Bathshua` (one word); final comma → semicolon |
| 4 | 1CH 4:8 | Wording | `Zobebah` → `Hazzobebah` (keeps the Hebrew article) |
| 5 | 1CH 4:21 | Punctuation only | Comma added after `Mareshah`; trailing comma after `Beth Ashbea` removed |
| 6 | 1CH 4:26 | Punctuation only | Comma added after each name; list separators → semicolons |
| 7 | 1CH 5:6 | Wording | `Tiglath Pileser` → `Tilgath Pilneser`; `Reubenites` → `Reubenite` |
| 8 | 1CH 5:18 | Wording | `Gadites` → `Gadite` |
| 9 | 1CH 5:26 | Wording | `Tiglath Pileser` → `Tilgath Pilneser`; drops `namely`; both tribe names to singular |
| 10 | 1CH 7:8 | Punctuation only | Comma added after `Abijah` |
| 11 | 1CH 7:15 | Wording | `Maacah` → `Maachah` |
| 12 | 1CH 7:16 | Wording | `Maacah` → `Maachah` |
| 13 | 1CH 7:20 | Punctuation only | Comma added after the second `Tahath` |
| 14 | 1CH 7:40 | Wording | `warriors of valor` → `warriors of valors` |
| 15 | 1CH 11:29 | Punctuation only | Commas after the two names removed; separators → semicolons |
| 16 | 1CH 11:35 | Punctuation only | Two list commas → semicolons |
| 17 | 1CH 11:36 | Punctuation only | Commas after the two names removed; separators → semicolons |
| 18 | 1CH 12:14 | Punctuation only | Comma added after `the least` |
| 19 | 1CH 12:19 | Punctuation only | Comma after `counsel` removed |
| 20 | 1CH 12:34 | Punctuation only | Comma added after `them` |
| 21 | 1CH 12:35 | Wording | `Danites` → `Danite` |
| 22 | 1CH 15:21 | Punctuation only | Comma added after `Mikneiah` |
| 23 | 1CH 17:1 | Punctuation only | Comma after `house` removed; comma added after `Behold` |
| 24 | 1CH 20:6 | Wording | Both clauses recast: `there was battle` → `battle was`, `there was a man` → `a man … was {there}` |
| 25 | 1CH 24:6 | Punctuation only | Comma added after `Eleazar` |
| 26 | 1CH 24:9 | Punctuation only | Two list commas → semicolons |
| 27 | 1CH 24:17 | Punctuation only | Two list commas → semicolons |
| 28 | 1CH 24:25 | Punctuation only | Comma after `Isshiah` → semicolon |
| 29 | 1CH 25:4 | Punctuation only | Two group-separating commas → semicolons |
| 30 | 1CH 25:14 | Punctuation only | Final comma → semicolon |
| 31 | 1CH 26:4 | Punctuation only | Five list commas → semicolons |
| 32 | 1CH 26:11 | Punctuation only | Two list commas → semicolons |
| 33 | 1CH 26:31 | Punctuation only | Comma after `Jerijah` removed |

### Patterns worth deciding once instead of thirty-three times

Most of these are not thirty-three independent judgments. Three clusters account for nearly all of them:

1. **Semicolons between roster items** (11:29, 11:35, 11:36, 24:9, 24:17, 24:25, 25:4, 25:14, 26:4, 26:11, 4:26 — and carried along inside 2:42, 3:2, 3:5). His version separates the entries of a genealogy or duty roster with semicolons where Door43 now has commas. This looks like one deliberate punctuation convention applied consistently, so it can probably be accepted or declined as a single decision.
2. **Collective singular for tribe and clan names** (5:6, 5:18, 5:26, 12:35). His version reads `the Reubenite`, `the Gadite`, `the Danite` where Door43 now has the English plural. In each case the Hebrew behind the word is the singular gentilic form (for example `גָּדִי` in 5:18), so this is a consistent form-matching choice, again decidable once.
3. **Single commas added or removed** (4:21, 7:8, 7:20, 12:14, 12:19, 12:34, 15:21, 17:1, 24:6, 26:31). These are genuinely individual and need reading one by one.

That leaves a small number of real wording questions: 2:42, 3:2, 3:5, 4:8, 7:15, 7:16, 7:40, 20:6, plus the proper-name spelling inside 5:6 and 5:26.

---

## The 33 verses

### 1 — 1CH 2:42 · Wording

**His version**
> And the sons of Caleb, the brother of Jerahmeel: Mesha, his firstborn; he {was} the father of Ziph. And the sons of Mareshah, the father of Hebron.

**Current version**
> And the sons of Caleb, the brother of Jerahmeel: Mareshah his firstborn, he {was} the father of Ziph. And the sons of Mareshah, the father of Hebron.

- **What changed:** `Mareshah his firstborn,` → `Mesha, his firstborn;` — the name is changed, a comma is added after it, and the following comma becomes a semicolon.
- **Whose work this affects:** Carolyn1970, D1 row version 3, last edited 2026-06-22 21:03 UTC.
- **This one looks clear-cut.** The English word in question is aligned to the Hebrew `מֵישָׁע` (Strong's H4337), which transliterates as *Mesha*. The current text reads `Mareshah` against that word, while the actual `מָרֵשָׁה` (H4762) appears later in the same verse and is also rendered `Mareshah` — so the verse currently uses one name for two different Hebrew names. His `Mesha` matches the Hebrew it is aligned to.

### 2 — 1CH 3:2 · Wording

**His version**
> the third, Absalom, the son of Maakah, the daughter of Talmai, the king of Geshur; the fourth, Adonijah, the son of Haggith;

**Current version**
> the third, Absalom, the son of Maacah, the daughter of Talmai, the king of Geshur, the fourth, Adonijah, the son of Haggith,

- **What changed:** `Maacah` → `Maakah`, and the two commas that separate the roster entries (after `Geshur` and after `Haggith`) become semicolons.
- **Whose work this affects:** Carolyn1970, D1 row version 5, last edited 2026-07-15 16:41 UTC.
- **Worth noticing:** the Hebrew is `מַעֲכָה` (H4601). His file spells this name three different ways in three places — `Maakah` here, `Maachah` in 7:15 and 7:16 — so whichever spelling is chosen, it is worth choosing one and applying it consistently across the book.

### 3 — 1CH 3:5 · Wording

**His version**
> And these were born to him in Jerusalem: Shimea and Shobab and Nathan and Solomon, four by Bathshua, the daughter of Ammiel;

**Current version**
> And these were born to him in Jerusalem: Shimea and Shobab and Nathan and Solomon, four by Bath Shua, the daughter of Ammiel,

- **What changed:** `Bath Shua` → `Bathshua` (closed up into one word), and the final comma becomes a semicolon.
- **Whose work this affects:** Carolyn1970, D1 row version 4, last edited 2026-07-15 16:41 UTC.
- **Background:** the Hebrew name is the hyphen-joined compound `בַּת־שׁוּעַ`, so either the two-word or the closed-up form is defensible; this is a house-style call.

### 4 — 1CH 4:8 · Wording

**His version**
> and Koz, {who} fathered Anub and Hazzobebah and the clans of Aharhel, the son of Harum.

**Current version**
> and Koz, {who} fathered Anub and Zobebah and the clans of Aharhel, the son of Harum.

- **What changed:** `Zobebah` → `Hazzobebah`.
- **Whose work this affects:** Carolyn1970, D1 row version 3, last edited 2026-06-18 20:07 UTC.
- **Background:** the Hebrew is `הַצֹּבֵבָה`, where the leading `ה` is the definite article and the dictionary form of the name is `צֹבֵבָה`. His `Hazzobebah` transliterates the article along with the name; the current `Zobebah` gives the bare name. Both appear in published English Bibles; this is a transliteration-policy call.

### 5 — 1CH 4:21 · Punctuation only

**His version**
> The sons of Shelah, the son of Judah: Er, the father of Lecah, and Laadah, the father of Mareshah, and the clans of the house of the service of linen at Beth Ashbea

**Current version**
> The sons of Shelah, the son of Judah: Er, the father of Lecah, and Laadah, the father of Mareshah and the clans of the house of the service of linen at Beth Ashbea,

- **What changed:** a comma is added after `Mareshah`, and the comma at the end after `Beth Ashbea` is removed.
- **Whose work this affects:** Carolyn1970, D1 row version 5, last edited 2026-06-18 20:13 UTC.

### 6 — 1CH 4:26 · Punctuation only

**His version**
> And the sons of Mishma: Hammuel, his son; Zaccur, his son; Shimei, his son.

**Current version**
> And the sons of Mishma: Hammuel his son, Zaccur his son, Shimei his son.

- **What changed:** a comma is added after each name, and the commas separating the three entries become semicolons.
- **Whose work this affects:** Carolyn1970, D1 row version 6, last edited 2026-06-22 21:12 UTC.

### 7 — 1CH 5:6 · Wording

**His version**
> Beerah, his son, whom Tilgath Pilneser, the king of Assyria, exiled. He {was} a leader of the Reubenite.

**Current version**
> Beerah, his son, whom Tiglath Pileser, the king of Assyria, exiled. He {was} a leader of the Reubenites.

- **What changed:** `Tiglath Pileser` → `Tilgath Pilneser`, and `the Reubenites` → `the Reubenite`.
- **Whose work this affects:** Carolyn1970, D1 row version 3, last edited 2026-06-17 16:28 UTC.
- **Background on the king's name:** the Hebrew actually written here is `תִּלְּגַת פִּלְנְאֶסֶר`, while the dictionary form recorded in the alignment is `תִּגְלַת פִּלְאֶסֶר`. So his `Tilgath Pilneser` follows the spelling as it stands in Chronicles, and the current `Tiglath Pileser` follows the standard English name (the form used in Kings). This is a real policy question for a form-centric translation like the ULT, and it recurs in 5:26.
- **Background on `Reubenite`:** the Hebrew `רְאוּבֵנִי` is singular. See pattern 2 above.

### 8 — 1CH 5:18 · Wording

**His version**
> The sons of Reuben and the Gadite and half of the tribe of Manasseh, from sons of valor, men, carriers of the shield and sword and treaders of the bow and taught of battle, {were} 44,760 going out {as} an army.

**Current version**
> The sons of Reuben and the Gadites and half of the tribe of Manasseh, from sons of valor, men, carriers of the shield and sword and treaders of the bow and taught of battle, {were} 44,760 going out {as} an army.

- **What changed:** `the Gadites` → `the Gadite`. Nothing else.
- **Whose work this affects:** Carolyn1970, D1 row version 3, last edited 2026-06-17 16:39 UTC.
- **Background:** the Hebrew is the singular `גָּדִי`. See pattern 2 above.

### 9 — 1CH 5:26 · Wording

**His version**
> So the God of Israel awakened the spirit of Pul, the king of Assyria and the spirit of Tilgath Pilneser, the king of Assyria. And he exiled them, the Reubenite and the Gadite and half of the tribe of Manasseh. And he brought them to Halah and Habor and Hara and the river of Gozan unto this day.

**Current version**
> So the God of Israel awakened the spirit of Pul, the king of Assyria and the spirit of Tiglath Pileser, the king of Assyria. And he exiled them, namely the Reubenites and the Gadites and half of the tribe of Manasseh. And he brought them to Halah and Habor and Hara and the river of Gozan unto this day.

- **What changed:** `Tiglath Pileser` → `Tilgath Pilneser`; `namely the Reubenites and the Gadites` → `the Reubenite and the Gadite`, dropping the connecting word `namely` and putting both tribe names in the singular.
- **Whose work this affects:** Carolyn1970, D1 row version 3, last edited 2026-06-17 16:45 UTC.
- **One caveat if this verse is accepted as-is:** in his file the two Hebrew words of the king's name are stored in the wrong order behind the scenes — the alignment attaches `Tilgath` to `פִּלְנֶסֶר` and `Pilneser` to `תִּלְּגַת`, the reverse of the Hebrew word order. The English reads correctly either way, and the current Door43 version has them in the right order. So if his reading is accepted here, the wording should be re-entered in Bible Editor rather than the whole verse copied across, so the alignment order is not spoiled.

### 10 — 1CH 7:8 · Punctuation only

**His version**
> And the sons of Becher: Zemirah and Joash and Eliezer and Elioenai and Omri and Jeremoth and Abijah, and Anathoth and Alemeth. All of these [were} the sons of Becher,

**Current version**
> And the sons of Becher: Zemirah and Joash and Eliezer and Elioenai and Omri and Jeremoth and Abijah and Anathoth and Alemeth. All of these [were} the sons of Becher,

- **What changed:** a comma is added after `Abijah`.
- **Whose work this affects:** Carolyn1970, D1 row version 5, last edited 2026-06-19 21:21 UTC.
- **Note:** the mismatched bracket in `[were}` is present in both versions and is not part of this difference. It looks like a stray typo for `{were}` and is worth fixing separately.

### 11 — 1CH 7:15 · Wording

**His version**
> And Machir took a wife of Huppim and of Shuppim. And the name of his sister {was} Maachah. And the name of the second, Zelophehad. And daughters were to Zelophehad.

**Current version**
> And Machir took a wife of Huppim and of Shuppim. And the name of his sister {was} Maacah. And the name of the second, Zelophehad. And daughters were to Zelophehad.

- **What changed:** `Maacah` → `Maachah`.
- **Whose work this affects:** Carolyn1970, D1 row version 4, last edited 2026-06-19 20:27 UTC.
- **Background:** the Hebrew is `מַעֲכָה` (H4601). Compare 3:2, where his file spells the same name `Maakah`.

### 12 — 1CH 7:16 · Wording

**His version**
> And Maachah, the wife of Machir, bore a son and she called his name Peresh. And the name of his brother {was} Sheresh, and his sons {were} Ulam and Rakem.

**Current version**
> And Maacah, the wife of Machir, bore a son and she called his name Peresh. And the name of his brother {was} Sheresh, and his sons {were} Ulam and Rakem.

- **What changed:** `Maacah` → `Maachah`.
- **Whose work this affects:** Carolyn1970, D1 row version 4, last edited 2026-06-19 20:31 UTC.
- **Background:** same name and same question as 7:15 — decide the two together.

### 13 — 1CH 7:20 · Punctuation only

**His version**
> And the sons of Ephraim: Shuthelah and Bered his son, and Tahath his son, and Eleadah his son, and Tahath, his son,

**Current version**
> And the sons of Ephraim: Shuthelah and Bered his son, and Tahath his son, and Eleadah his son, and Tahath his son,

- **What changed:** a comma is added after the **second** `Tahath` only.
- **Whose work this affects:** Carolyn1970, D1 row version 5, last edited 2026-06-19 21:27 UTC.
- **Worth noticing:** the identical phrase earlier in the same verse (`and Tahath his son`) is left without the comma in his version too, so accepting this as written would make the verse internally inconsistent.

### 14 — 1CH 7:40 · Wording

**His version**
> All of these {were} sons of Asher, heads of the house of their fathers, chosen, warriors of valors, heads of chiefs, enrolled in the army for battle. Their number {was} 26,000 men.

**Current version**
> All of these {were} sons of Asher, heads of the house of their fathers, chosen, warriors of valor, heads of chiefs, enrolled in the army for battle. Their number {was} 26,000 men.

- **What changed:** `warriors of valor` → `warriors of valors`.
- **Whose work this affects:** Carolyn1970, D1 row version 3, last edited 2026-06-19 21:39 UTC.
- **Background:** the Hebrew word behind it, `חֲיָלִים`, is plural, so his `valors` matches the Hebrew number. Whether English `valors` is acceptable is the judgment to make.

### 15 — 1CH 11:29 · Punctuation only

**His version**
> Sibbecai the Hushathite; Ilai the Ahohite;

**Current version**
> Sibbecai, the Hushathite, Ilai, the Ahohite,

- **What changed:** the comma after each name is removed, and both entry separators become semicolons.
- **Whose work this affects:** Carolyn1970, D1 row version 6, last edited 2026-07-02 20:54 UTC.

### 16 — 1CH 11:35 · Punctuation only

**His version**
> Ahiam, the son of Sachar, the Hararite; Eliphal, the son of Ur;

**Current version**
> Ahiam, the son of Sachar, the Hararite, Eliphal, the son of Ur,

- **What changed:** the two commas that separate roster entries (after `Hararite` and after `Ur`) become semicolons.
- **Whose work this affects:** Carolyn1970, D1 row version 6, last edited 2026-07-02 20:58 UTC.

### 17 — 1CH 11:36 · Punctuation only

**His version**
> Hepher the Mecherathite; Ahijah the Pelonite;

**Current version**
> Hepher, the Mecherathite, Ahijah, the Pelonite,

- **What changed:** the comma after each name is removed, and both entry separators become semicolons — the same shape as 11:29.
- **Whose work this affects:** Carolyn1970, D1 row version 6, last edited 2026-07-02 20:58 UTC.

### 18 — 1CH 12:14 · Punctuation only

**His version**
> These {were} from the sons of Gad, heads of the army. One, the least, {was} for 100, and the greatest {was} for 1,000.

**Current version**
> These {were} from the sons of Gad, heads of the army. One, the least {was} for 100, and the greatest {was} for 1,000.

- **What changed:** a comma is added after `the least`.
- **Whose work this affects:** Carolyn1970, D1 row version 3, last edited 2026-06-27 21:12 UTC.

### 19 — 1CH 12:19 · Punctuation only

**His version**
> And {some} from Manasseh fell to David when he came with the Philistines to battle against Saul. But they did not help them, for by counsel the lords of the Philistines sent him away, saying, “By our heads, he will fall to his master Saul.”

**Current version**
> And {some} from Manasseh fell to David when he came with the Philistines to battle against Saul. But they did not help them, for by counsel, the lords of the Philistines sent him away, saying, “By our heads, he will fall to his master Saul.”

- **What changed:** the comma after `counsel` is removed.
- **Whose work this affects:** Carolyn1970, D1 row version 3, last edited 2026-06-27 21:16 UTC.

### 20 — 1CH 12:34 · Punctuation only

**His version**
> And from Naphtali, 1,000 commanders, and with them, with shield and spear, 37,000.

**Current version**
> And from Naphtali, 1,000 commanders, and with them with shield and spear, 37,000.

- **What changed:** a comma is added after `them`.
- **Whose work this affects:** Carolyn1970, D1 row version 3, last edited 2026-06-27 21:20 UTC.

### 21 — 1CH 12:35 · Wording

**His version**
> And from the Danite, arrayers of battle, 28,600.

**Current version**
> And from the Danites, arrayers of battle, 28,600.

- **What changed:** `the Danites` → `the Danite`.
- **Whose work this affects:** Carolyn1970, D1 row version 4, last edited 2026-06-27 20:50 UTC.
- **Background:** the Hebrew is the singular `הַדָּנִי`. See pattern 2 above — decide alongside 5:6, 5:18 and 5:26.

### 22 — 1CH 15:21 · Punctuation only

**His version**
> And Mattithiah and Eliphelehu and Mikneiah, and Obed Edom and Jeiel and Azaziah with lyres, to lead according to Sheminith.

**Current version**
> And Mattithiah and Eliphelehu and Mikneiah and Obed Edom and Jeiel and Azaziah with lyres, to lead according to Sheminith.

- **What changed:** a comma is added after `Mikneiah`.
- **Whose work this affects:** Carolyn1970, D1 row version 3, last edited 2026-06-30 16:21 UTC.

### 23 — 1CH 17:1 · Punctuation only

**His version**
> And it happened when David had dwelled in his house that David said to Nathan the prophet, “Behold, I, I am dwelling in a house of cedars, but the Box of the Covenant of Yahweh {is} under curtains.”

**Current version**
> And it happened when David had dwelled in his house, that David said to Nathan the prophet, “Behold I, I am dwelling in a house of cedars, but the Box of the Covenant of Yahweh {is} under curtains.”

- **What changed:** the comma after `house` is removed, and a comma is added after `Behold`.
- **Whose work this affects:** Carolyn1970, D1 row version 4, last edited 2026-07-02 20:07 UTC.

### 24 — 1CH 20:6 · Wording

**His version**
> And battle was again at Gath, and a man of stature was {there}, and his digits were six and six, 24. And he also was born to Rapha.

**Current version**
> And there was battle again at Gath, and there was a man of stature and his digits were six and six, 24. And he also was born to Rapha.

- **What changed:** both opening clauses are recast. `And there was battle again at Gath` becomes `And battle was again at Gath`, and `and there was a man of stature and his digits` becomes `and a man of stature was {there}, and his digits` — moving the supplied word `there` to the end of the clause and marking it as supplied.
- **Whose work this affects:** Carolyn1970, D1 row version 3, last edited 2026-07-07 23:10 UTC.
- **Note:** this is the only one of the 33 that changes sentence structure rather than a name, a number form, or a mark. Both readings render the same Hebrew verb `הָיָה`.

### 25 — 1CH 24:6 · Punctuation only

**His version**
> And Shemaiah, the son of Nethanel, the scribe from the Levites, wrote them to the face of the king and the officials and Zadok the priest and Ahimelech, the son of Abiathar, and the heads of the fathers for the priests and for the Levites. One house of a father was taken for Eleazar, and was taken, was taken for Ithamar.

**Current version**
> And Shemaiah, the son of Nethanel, the scribe from the Levites, wrote them to the face of the king and the officials and Zadok the priest and Ahimelech, the son of Abiathar, and the heads of the fathers for the priests and for the Levites. One house of a father was taken for Eleazar and was taken, was taken for Ithamar.

- **What changed:** a comma is added after `Eleazar`.
- **Whose work this affects:** Carolyn1970, D1 row version 2, last edited 2026-07-13 15:35 UTC.

### 26 — 1CH 24:9 · Punctuation only

**His version**
> the fifth, for Malchijah; the sixth, for Mijamin;

**Current version**
> the fifth, for Malchijah, the sixth, for Mijamin,

- **What changed:** the two commas that separate roster entries become semicolons.
- **Whose work this affects:** Carolyn1970, D1 row version 6, last edited 2026-07-15 16:42 UTC.

### 27 — 1CH 24:17 · Punctuation only

**His version**
> the twenty-first, for Jachin; the twenty-second, for Gamul;

**Current version**
> the twenty-first, for Jachin, the twenty-second, for Gamul,

- **What changed:** the two commas that separate roster entries become semicolons.
- **Whose work this affects:** Carolyn1970, D1 row version 6, last edited 2026-07-15 16:43 UTC.

### 28 — 1CH 24:25 · Punctuation only

**His version**
> The brother of Micah: Isshiah; of the sons of Isshiah, Zechariah.

**Current version**
> The brother of Micah: Isshiah, of the sons of Isshiah, Zechariah.

- **What changed:** the comma after the first `Isshiah` becomes a semicolon.
- **Whose work this affects:** Carolyn1970, D1 row version 7, last edited 2026-07-15 16:44 UTC.

### 29 — 1CH 25:4 · Punctuation only

**His version**
> Of Heman, the sons of Heman: Bukkiah, Mattaniah, Uzziel, Shebuel, and Jerimoth; Hananiah, Hanani, Eliathah, Giddalti, and Romamti Ezer; Joshbekashah, Mallothi, Hothir, Mahazioth.

**Current version**
> Of Heman, the sons of Heman: Bukkiah, Mattaniah, Uzziel, Shebuel, and Jerimoth, Hananiah, Hanani, Eliathah, Giddalti, and Romamti Ezer, Joshbekashah, Mallothi, Hothir, Mahazioth.

- **What changed:** the two commas that separate the three groups of names (after `Jerimoth` and after `Romamti Ezer`) become semicolons.
- **Whose work this affects:** Carolyn1970, D1 row version 8, last edited 2026-07-15 16:44 UTC.

### 30 — 1CH 25:14 · Punctuation only

**His version**
> the seventh, Jesharelah, his sons and his brothers, 12;

**Current version**
> the seventh, Jesharelah, his sons and his brothers, 12,

- **What changed:** the comma at the end becomes a semicolon.
- **Whose work this affects:** Carolyn1970, D1 row version 5, last edited 2026-07-15 16:45 UTC.

### 31 — 1CH 26:4 · Punctuation only

**His version**
> And sons {were} to Obed Edom: Shemaiah, the firstborn; Jehozabad, the second; Joah, the third; and Sachar, the fourth; and Nethanel, the fifth;

**Current version**
> And sons {were} to Obed Edom: Shemaiah, the firstborn, Jehozabad, the second, Joah, the third, and Sachar, the fourth, and Nethanel, the fifth,

- **What changed:** all five commas that separate the roster entries become semicolons.
- **Whose work this affects:** Carolyn1970, D1 row version 9, last edited 2026-07-15 16:46 UTC.

### 32 — 1CH 26:11 · Punctuation only

**His version**
> Hilkiah, the second; Tebaliah, the third; Zechariah, the fourth. All of the sons and brothers to Hosah {were} 13.

**Current version**
> Hilkiah, the second, Tebaliah, the third, Zechariah, the fourth. All of the sons and brothers to Hosah {were} 13.

- **What changed:** the two commas that separate the roster entries become semicolons.
- **Whose work this affects:** Carolyn1970, D1 row version 5, last edited 2026-07-15 16:47 UTC.

### 33 — 1CH 26:31 · Punctuation only

**His version**
> Of the Hebronite, Jerijah the head of the Hebronite, according to his generations of fathers. In year 40 of the reign of David, they were sought, and it was found among them warriors of valor in Jazer of Gilead.

**Current version**
> Of the Hebronite, Jerijah, the head of the Hebronite, according to his generations of fathers. In year 40 of the reign of David, they were sought, and it was found among them warriors of valor in Jazer of Gilead.

- **What changed:** the comma after `Jerijah` is removed.
- **Whose work this affects:** Carolyn1970, D1 row version 5, last edited 2026-07-15 16:38 UTC.

---

## Two things the reviewer should know

### 1. The translationCore project for 1 Chronicles is out of date — please refresh it before exporting again

The tC project these edits came from is working from 1 Chronicles ULT roughly as it stood on **12 June 2026**. Door43 has moved on considerably since then, mostly through checking work done in Bible Editor. That staleness is why 151 of the 184 differing verses were old text coming back rather than new work, and it is why the 33 real edits arrived mixed in with a large amount of noise that had to be sorted out by hand.

Exporting again from the same project would repeat exactly this, and next time the good work could be even harder to separate out. **Before the next export, please pull current `master` for 1 Chronicles into the tC project** so the export carries only new decisions. The same caution applies to any other book whose tC project has been open for a while.

### 2. The underlying cause is ours, and it is being fixed separately

None of this is a mistake on the reviewer's side. Today, once a verse has been edited in Bible Editor, the nightly export treats the editor's copy as authoritative and will overwrite a change made on the Door43 side — so a correction made anywhere else cannot get in. That behaviour is being addressed in its own piece of work; this document is only about deciding the 33 verses that were lost while it stood.

In the meantime, the safe route for any of these 33 that is accepted is to enter it **in Bible Editor**, not directly on Door43, so that the nightly export publishes it rather than reverts it.

---

## How these 33 were identified

For the record, so the shortlist can be checked independently:

- **His file:** `https://git.door43.org/unfoldingWord/en_ult/raw/commit/5905373879/13-1CH.usfm` — pushed 2026-08-10 16:29 UTC, with a translationCore content stamp of Thu 16 Jul 2026.
- **Current file:** `https://git.door43.org/unfoldingWord/en_ult/raw/branch/master/13-1CH.usfm`.
- 184 verses differ between the two. Each was compared against every earlier commit of the file on Door43 that predates his tC content stamp.
- Where his wording matched one of those earlier versions, it is old text coming back: `DROP_STALE_BASELINE`, 129 verses.
- Where the Bible Editor row was demonstrably the later edit of the two: `DROP_D1_EDIT_IS_NEWER`, 18 verses.
- Where the only difference was the position of a line break in the file: `DROP_COSMETIC_LINE_WRAP`, 4 verses.
- The remaining **33** matched no earlier version, which is what makes them new work rather than a regression: `REVIEW_NOVEL_TC_EDIT`. 12 differ in wording, 21 in punctuation only. 129 + 18 + 4 + 33 = 184.
- The verse texts above were produced by stripping the alignment markup from both files and keeping the words and punctuation. As a check on that stripping, each verse was independently re-classified as wording-level or punctuation-only from the stripped text, and all 33 agreed with the original classification.
- The editor and timestamp for each verse were read from the production database (`verses` joined to `users`); all 33 rows are attributed to user id 47, `Carolyn1970`.
