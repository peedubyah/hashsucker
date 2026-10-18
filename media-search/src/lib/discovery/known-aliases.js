/**
 * Curated accepted-title aliases (identity-correctness slice).
 *
 * Purpose: let legitimate alternate-language / stylized / abbreviated
 * releases match through EXPLICIT evidence instead of weakened fuzzy
 * containment. Each entry is an exact spelling observed on a real release
 * in this corpus (or operator-verified against independently confirmed
 * content). Matching is still exact token-set comparison (titlesMatch)
 * — an alias never loosens the matcher, it only adds another exact
 * target. Bilingual "Foreign - English" rows additionally require BOTH
 * halves to be known strings (see matchBilingualSegments); an alias
 * alone never blesses an unknown co-title.
 *
 * Admission bar for a new entry (all required):
 *   1. The spelling is observed on a real release, or operator-verified
 *      against independently confirmed content (not inferred).
 *   2. It denotes the SAME media, not a sequel/remake/collection
 *      ("Dune - Parte Due" is not added: the hybrid row carries both
 *      languages and can never match a single alias exactly).
 *   3. The canonical title alone rejects the observed row (otherwise no
 *      entry is needed).
 *
 * Aliases NEVER override a year contradiction or an S/E contradiction —
 * they only widen the title comparison. Do not add transliterations you
 * have not seen on a real release.
 */

const TABLE = new Map(Object.entries({
  // Seven (1995) — intentional stylization, observed on UHD remux rows.
  tt0114369: ['Se7en'],
  // Star Wars Episode V (1980) — full German release title, observed
  // verbatim in ASCII-fied scene spelling ("...Das.Imperium.schlaegt.
  // zurueck.1980..."), plus the operator-verified Italian title and the
  // observed Polish collection prefix (single-film Polish rows match the
  // short alias exactly).
  tt0080684: [
    'Star Wars Episode V Das Imperium schlaegt zurueck',
    "L'Impero colpisce ancora",
    'Das Imperium schlaegt zurueck',
    'Gwiezdne wojny',
  ],
  // The Godfather (1972) — Italian title, observed on a dual-language row,
  // plus the exact observed bilingual rendering ("...The.Godfather.I.1972...")
  // whose trailing part-marker would otherwise defeat prefix matching.
  tt0068646: ['Il Padrino', 'Il Padrino The Godfather I'],
  // Harakiri (1962) — Japanese title, observed ("Seppuku.1962...").
  tt0056058: ['Seppuku'],
  // The Good, the Bad and the Ugly (1966) — Italian title, observed.
  tt0060196: ['Il buono, il brutto, il cattivo'],
  // The Shawshank Redemption (1994) — Italian title, observed on a
  // bilingual row (diacritic folding covers Liberta').
  tt0111161: ['Le ali della libertà'],
  // Butch Cassidy and the Sundance Kid (1969) — Spanish title, observed.
  tt0064115: ['Dos hombres y un destino'],
  // 2001: A Space Odyssey (1968) — Italian title, observed.
  tt0062622: ['2001 Odissea nello spazio'],
  // Once Upon a Time in America (1984) — Italian title, observed on a
  // bilingual "C'era una Volta in America - Once Upon..." row.
  tt0087843: ["C'era una volta in America"],
  // Gone with the Wind (1939) — Italian title, observed on a bilingual
  // "Via col vento - Gone with the Wind" row.
  tt0031381: ['Via col vento'],
  // Dr. Strangelove (1964) — common short title. The canonical VFS
  // title carries the full subtitle ("...or How I Learned..."), which
  // can never match terse release titles token-for-token.
  tt0057012: ['Dr Strangelove', 'Dr. Strangelove'],
  // Dune (2021) — "Part One" retitle, observed ("Dune.Part.One.2021").
  // Digit-form "Part 2" stays non-benign: the fold only equates the
  // number that is already agreed, it never drops a differing number.
  tt1160419: ['Dune Part One'],
  // Sunset Boulevard (1950) — standard abbreviation, observed.
  tt0043014: ['Sunset Blvd'],
  // Psycho (1960) — Spanish title, observed; plus the observed
  // truncated spelling on Italian UHD rips.
  tt0054215: ['Psicosis', 'Psyco'],
  // Vertigo (1958) — French and Italian titles, observed.
  tt0052357: ['Sueurs froides', 'La donna che visse due volte'],
  // The 400 Blows (1959) — French (arguably primary) and Italian
  // titles, observed.
  tt0053198: ['Les quatre cents coups', 'I 400 colpi'],
  // Witness for the Prosecution (1957) — French and Italian titles,
  // observed (bilingual "Testimone d'accusa-Witness..." row included).
  tt0051201: ["Témoin à charge", "Testimone d'accusa"],
  // GoodFellas (1990) — Italian and Polish titles, observed on
  // bilingual rows ("Quei Bravi Ragazzi Goodfellas",
  // "Chłopcy z Ferajny Goodfellas").
  tt0099685: ['Quei bravi ragazzi', 'Chłopcy z ferajny'],
  // Saving Private Ryan (1998) — French and Italian titles, observed.
  tt0120815: ['Il faut sauver le soldat Ryan', 'Salvate il soldato Ryan'],
  // Back to the Future (1985) — Italian title, observed on a bilingual
  // "Ritorno al Futuro Back to the Future" row.
  tt0088763: ['Ritorno al futuro'],
  // Some Like It Hot (1959) — Spanish title, observed.
  tt0053298: ['Con faldas y a lo loco'],
  // Singin' in the Rain (1952) — Spanish title, observed.
  tt0045152: ['Cantando bajo la lluvia'],
  // Rear Window (1954) — Spanish title, observed.
  tt0047396: ['La ventana indiscreta'],
  // North by Northwest (1959) — Spanish title, observed.
  tt0053125: ['Con la muerte en los talones'],
  // Fellini's 8½ (1963) — English literal title, and the bare digit
  // for single-file "8 (1963)" rows. The VFS spelling "81⁄2" is a
  // filesystem-safe fraction form, never a release spelling.
  tt0056801: ['Eight and a Half', '8'],
  // Total Recall (1990) and Total Recall (2012) — Italian title, observed
  // on version-separated rows. The year gate (not the alias) separates
  // the versions: same alias on both IDs is correct.
  tt0100802: ['Atto di forza'],
  tt1386703: ['Atto di forza'],
  // Gladiator (2000) — Italian title, observed.
  tt0172495: ['Il gladiatore'],
  // Reservoir Dogs (1992) — Italian title ("Le iene"), observed on
  // multiple rows. Collides with nothing else in the catalog.
  tt0105236: ['Le iene'],
  // The Human Condition III (1961) — Italian full title, observed
  // verbatim on a bilingual "X - Y" row; both halves are accepted aliases
  // so the bilingual construction verifies.
  tt0055233: ['La condizione umana parte III', 'La preghiera di un soldato'],
}));

/**
 * Curated aliases for an IMDb ID. Returns a fresh array (possibly empty).
 * @param {string} mediaId
 * @returns {string[]}
 */
export function knownAliasesFor(mediaId) {
  const hit = TABLE.get(String(mediaId || ''));
  return hit ? [...hit] : [];
}
