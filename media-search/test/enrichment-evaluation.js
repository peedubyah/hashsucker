/**
 * Enrichment Effectiveness Evaluation
 *
 * Evaluates the enrichment pipeline using real DMM corpus samples.
 * Measures parser success, identity resolution, and failure categories.
 *
 * Usage: node test/enrichment-evaluation.js
 */

import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import { parseFilename } from '../src/lib/discovery/parser-adapter.js';
import { storeReleaseAttributes, getStrongestReleaseAttributes } from '../src/lib/discovery/release-attributes.js';
import { enrichWithCinemeta } from '../src/lib/discovery/enrichment-sources/cinemeta.js';
import { enrichCandidate } from '../src/lib/discovery/enrichment.js';
import { computeConfidence, titleMatchQuality, yearMatch } from '../src/lib/discovery/enrichment-sources/confidence.js';

// =============================================================================
// DMM Corpus Samples (real-world release filenames)
// =============================================================================

const SAMPLES = {
  movies: [
    { hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', filename: 'The.Matrix.1999.1080p.BluRay.x264-ESiR.mkv', expected: { title: 'The Matrix', year: 1999, type: 'movie' } },
    { hash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', filename: 'Inception.2010.2160p.UHD.BluRay.HDR.DV.HEVC.DTS-HD.MA.TrueHD.7.1.Atmos-PB69.mkv', expected: { title: 'Inception', year: 2010, type: 'movie' } },
    { hash: 'cccccccccccccccccccccccccccccccccccccccc', filename: 'Dune.2021.2160p.UHD.BluRay.HDR.DV.HEVC.DTS-HD.MA.GROUP.mkv', expected: { title: 'Dune', year: 2021, type: 'movie' } },
    { hash: 'dddddddddddddddddddddddddddddddddddddddd', filename: 'Blade.Runner.2049.2017.1080p.BluRay.REMUX.AVC.DTS-HD.MA.TrueHD.7.1.Atmos-FGT.mkv', expected: { title: 'Blade Runner 2049', year: 2017, type: 'movie' } },
    { hash: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', filename: 'Interstellar.2014.1080p.BluRay.x264-SPARKS.mkv', expected: { title: 'Interstellar', year: 2014, type: 'movie' } },
    { hash: 'ffffffffffffffffffffffffffffffffffffffff', filename: 'The.Dark.Knight.2008.1080p.BluRay.x264-SiNNERS.mkv', expected: { title: 'The Dark Knight', year: 2008, type: 'movie' } },
    { hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab', filename: 'Pulp.Fiction.1994.1080p.BluRay.x264-LEGi0N.mkv', expected: { title: 'Pulp Fiction', year: 1994, type: 'movie' } },
    { hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaac', filename: 'Fight.Club.1999.1080p.BluRay.x264-HDCLASSiCS.mkv', expected: { title: 'Fight Club', year: 1999, type: 'movie' } },
    { hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaad', filename: 'The.Shawshank.Redemption.1994.1080p.BluRay.x264-SiNNERS.mkv', expected: { title: 'The Shawshank Redemption', year: 1994, type: 'movie' } },
    { hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaae', filename: 'Forrest.Gump.1994.1080p.BluRay.x264-SiNNERS.mkv', expected: { title: 'Forrest Gump', year: 1994, type: 'movie' } },
    { hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaf', filename: 'The.Godfather.1972.1080p.BluRay.x264-SiNNERS.mkv', expected: { title: 'The Godfather', year: 1972, type: 'movie' } },
    { hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab0', filename: 'Schindlers.List.1993.1080p.BluRay.x264-SiNNERS.mkv', expected: { title: 'Schindlers List', year: 1993, type: 'movie' } },
    { hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab1', filename: 'Spirited.Away.2001.1080p.BluRay.x264-SiNNERS.mkv', expected: { title: 'Spirited Away', year: 2001, type: 'movie' } },
    { hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab2', filename: 'Parasite.2019.1080p.BluRay.x264-SiNNERS.mkv', expected: { title: 'Parasite', year: 2019, type: 'movie' } },
    { hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab3', filename: 'Everything.Everywhere.All.at.Once.2022.1080p.WEB-DL.AAC2.0.x264-TEPES.mkv', expected: { title: 'Everything Everywhere All at Once', year: 2022, type: 'movie' } },
  ],
  tvEpisodes: [
    { hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab4', filename: 'Game.of.Thrones.S01E01.2160p.DoVi.HDR.BluRay.REMUX.HEVC.DTS-HD.MA.TrueHD.7.1.Atmos-PB69.mkv', expected: { title: 'Game of Thrones', season: 1, episode: 1, type: 'episode' } },
    { hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab5', filename: 'Breaking.Bad.S05E14.1080p.BluRay.x264-TEST.mkv', expected: { title: 'Breaking Bad', season: 5, episode: 14, type: 'episode' } },
    { hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab6', filename: 'The.Wire.S01E01.720p.BluRay.x264-TEST.mkv', expected: { title: 'The Wire', season: 1, episode: 1, type: 'episode' } },
    { hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab7', filename: 'Friends.S01E01.720p.WEB-DL.x264-GROUP.mkv', expected: { title: 'Friends', season: 1, episode: 1, type: 'episode' } },
    { hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab8', filename: 'The.Office.S01E01.720p.WEB-DL.x264-GROUP.mkv', expected: { title: 'The Office', season: 1, episode: 1, type: 'episode' } },
    { hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab9', filename: 'Stranger.Things.S01E01.1080p.NF.WEB-DL.AAC2.0.x264-TEPES.mkv', expected: { title: 'Stranger Things', season: 1, episode: 1, type: 'episode' } },
    { hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaac0', filename: 'The.Mandalorian.S01E01.2160p.DSNP.WEB-DL.DDP5.1.x264-TEPES.mkv', expected: { title: 'The Mandalorian', season: 1, episode: 1, type: 'episode' } },
    { hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaac1', filename: 'Westworld.S01E01.1080p.HMAX.WEB-DL.DDP5.1.x264-TEPES.mkv', expected: { title: 'Westworld', season: 1, episode: 1, type: 'episode' } },
    { hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaac2', filename: 'The.Crown.S01E01.1080p.NF.WEB-DL.AAC2.0.x264-TEPES.mkv', expected: { title: 'The Crown', season: 1, episode: 1, type: 'episode' } },
    { hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaac3', filename: 'Black.Mirror.S03E01.1080p.WEB-DL.x264-TEST.mkv', expected: { title: 'Black Mirror', season: 3, episode: 1, type: 'episode' } },
    { hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaac4', filename: 'The.Sopranos.S01E01.720p.HDTV.x264-TEST.mkv', expected: { title: 'The Sopranos', season: 1, episode: 1, type: 'episode' } },
    { hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaac5', filename: 'The.Simpsons.S01E01.720p.WEB-DL.x264-GROUP.mkv', expected: { title: 'The Simpsons', season: 1, episode: 1, type: 'episode' } },
    { hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaac6', filename: 'South.Park.S01E01.720p.WEB-DL.x264-GROUP.mkv', expected: { title: 'South Park', season: 1, episode: 1, type: 'episode' } },
    { hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaac7', filename: 'Archer.2009.S01E01.720p.BluRay.x264-TEST.mkv', expected: { title: 'Archer 2009', season: 1, episode: 1, type: 'episode' } },
    { hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaac8', filename: 'Rick.and.Morty.S01E01.1080p.WEB-DL.x264-TEST.mkv', expected: { title: 'Rick and Morty', season: 1, episode: 1, type: 'episode' } },
  ],
  ambiguous: [
    { hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaac9', filename: 'Batman.1989.1080p.BluRay.x264-SiNNERS.mkv', expected: { title: 'Batman', year: 1989, type: 'movie', ambiguous: 'multiple Batman movies' } },
    { hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaad0', filename: 'Batman.Begins.2005.1080p.BluRay.x264-SiNNERS.mkv', expected: { title: 'Batman Begins', year: 2005, type: 'movie' } },
    { hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaad1', filename: 'The.Dark.Knight.Rises.2012.1080p.BluRay.x264-SiNNERS.mkv', expected: { title: 'The Dark Knight Rises', year: 2012, type: 'movie' } },
    { hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaad2', filename: 'Halloween.1978.1080p.BluRay.x264-SiNNERS.mkv', expected: { title: 'Halloween', year: 1978, type: 'movie', ambiguous: 'multiple Halloween movies' } },
    { hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaad3', filename: 'Halloween.2018.1080p.BluRay.x264-SiNNERS.mkv', expected: { title: 'Halloween', year: 2018, type: 'movie' } },
    { hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaad4', filename: 'Star.Wars.1977.1080p.BluRay.x264-SiNNERS.mkv', expected: { title: 'Star Wars', year: 1977, type: 'movie', ambiguous: 'multiple Star Wars movies' } },
    { hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaad5', filename: 'Star.Wars.Episode.V.The.Empire.Strikes.Back.1980.1080p.BluRay.x264-SiNNERS.mkv', expected: { title: 'Star Wars Episode V The Empire Strikes Back', year: 1980, type: 'movie' } },
    { hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaad6', filename: 'Alien.1979.1080p.BluRay.x264-SiNNERS.mkv', expected: { title: 'Alien', year: 1979, type: 'movie', ambiguous: 'multiple Alien movies' } },
    { hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaad7', filename: 'Aliens.1986.1080p.BluRay.x264-SiNNERS.mkv', expected: { title: 'Aliens', year: 1986, type: 'movie' } },
    { hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaad8', filename: 'Terminator.1984.1080p.BluRay.x264-SiNNERS.mkv', expected: { title: 'Terminator', year: 1984, type: 'movie', ambiguous: 'multiple Terminator movies' } },
    { hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaad9', filename: 'Terminator.2.Judgment.Day.1991.1080p.BluRay.x264-SiNNERS.mkv', expected: { title: 'Terminator 2 Judgment Day', year: 1991, type: 'movie' } },
  ],
  foreign: [
    { hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaae0', filename: 'Amelie.2001.1080p.BluRay.x264-SiNNERS.mkv', expected: { title: 'Amelie', year: 2001, type: 'movie', language: 'french' } },
    { hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaae1', filename: 'City.of.God.2002.1080p.BluRay.x264-SiNNERS.mkv', expected: { title: 'City of God', year: 2002, type: 'movie', language: 'portuguese' } },
    { hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaae2', filename: "Pan's.Labyrinth.2006.1080p.BluRay.x264-SiNNERS.mkv", expected: { title: "Pan's Labyrinth", year: 2006, type: 'movie', language: 'spanish' } },
    { hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaae3', filename: 'The.Lives.of.Others.2006.1080p.BluRay.x264-SiNNERS.mkv', expected: { title: 'The Lives of Others', year: 2006, type: 'movie', language: 'german' } },
    { hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaae4', filename: 'Downfall.2004.1080p.BluRay.x264-SiNNERS.mkv', expected: { title: 'Downfall', year: 2004, type: 'movie', language: 'german' } },
    { hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaae5', filename: 'Crouching.Tiger.Hidden.Dragon.2000.1080p.BluRay.x264-SiNNERS.mkv', expected: { title: 'Crouching Tiger Hidden Dragon', year: 2000, type: 'movie', language: 'chinese' } },
    { hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaae6', filename: 'Oldboy.2003.1080p.BluRay.x264-SiNNERS.mkv', expected: { title: 'Oldboy', year: 2003, type: 'movie', language: 'korean' } },
    { hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaae7', filename: 'A.Separation.2011.1080p.BluRay.x264-SiNNERS.mkv', expected: { title: 'A Separation', year: 2011, type: 'movie', language: 'persian' } },
  ],
  packs: [
    { hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaae8', filename: 'The.Lord.of.the.Rings.Trilogy.2001-2003.1080p.BluRay.x264-SiNNERS.mkv', expected: { title: 'The Lord of the Rings Trilogy', type: 'pack' } },
    { hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaae9', filename: 'The.Matrix.Trilogy.1999-2003.1080p.BluRay.x264-SiNNERS.mkv', expected: { title: 'The Matrix Trilogy', type: 'pack' } },
    { hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaf0', filename: 'Star.Wars.Saga.1977-2019.1080p.BluRay.x264-SiNNERS.mkv', expected: { title: 'Star Wars Saga', type: 'pack' } },
    { hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaf1', filename: 'Harry.Potter.Collection.2001-2011.1080p.BluRay.x264-SiNNERS.mkv', expected: { title: 'Harry Potter Collection', type: 'pack' } },
    { hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaf2', filename: 'Marvel.Cinematic.Universe.Phase.One.2008-2012.1080p.BluRay.x264-SiNNERS.mkv', expected: { title: 'Marvel Cinematic Universe Phase One', type: 'pack' } },
  ],
  edgeCases: [
    { hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaf3', filename: '1917.2019.1080p.BluRay.x264-SiNNERS.mkv', expected: { title: '1917', year: 2019, type: 'movie' } },
    { hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaf4', filename: '300.2007.1080p.BluRay.x264-SiNNERS.mkv', expected: { title: '300', year: 2007, type: 'movie' } },
    { hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaf5', filename: 'Se7en.1995.1080p.BluRay.x264-SiNNERS.mkv', expected: { title: 'Se7en', year: 1995, type: 'movie' } },
    { hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaf6', filename: '8.Mile.2002.1080p.BluRay.x264-SiNNERS.mkv', expected: { title: '8 Mile', year: 2002, type: 'movie' } },
    { hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaf7', filename: '12.Angry.Men.1957.1080p.BluRay.x264-SiNNERS.mkv', expected: { title: '12 Angry Men', year: 1957, type: 'movie' } },
    { hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaf8', filename: '2001.A.Space.Odyssey.1968.1080p.BluRay.x264-SiNNERS.mkv', expected: { title: '2001 A Space Odyssey', year: 1968, type: 'movie' } },
    { hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaf9', filename: '1984.1984.1080p.BluRay.x264-SiNNERS.mkv', expected: { title: '1984', year: 1984, type: 'movie' } },
    { hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab00', filename: '2012.2009.1080p.BluRay.x264-SiNNERS.mkv', expected: { title: '2012', year: 2009, type: 'movie' } },
  ],
};

// =============================================================================
// Mock Cinemeta API (simulates real Cinemeta responses)
// =============================================================================

const MOCK_CINEMETA = {
  'The Matrix': { id: 'tt0133093', type: 'movie', name: 'The Matrix', year: 1999 },
  'Inception': { id: 'tt1375666', type: 'movie', name: 'Inception', year: 2010 },
  'Dune': { id: 'tt1160419', type: 'movie', name: 'Dune', year: 2021 },
  'Blade Runner 2049': { id: 'tt1856101', type: 'movie', name: 'Blade Runner 2049', year: 2017 },
  'Interstellar': { id: 'tt0816692', type: 'movie', name: 'Interstellar', year: 2014 },
  'The Dark Knight': { id: 'tt0468569', type: 'movie', name: 'The Dark Knight', year: 2008 },
  'Pulp Fiction': { id: 'tt0110912', type: 'movie', name: 'Pulp Fiction', year: 1994 },
  'Fight Club': { id: 'tt0137523', type: 'movie', name: 'Fight Club', year: 1999 },
  'The Shawshank Redemption': { id: 'tt0111161', type: 'movie', name: 'The Shawshank Redemption', year: 1994 },
  'Forrest Gump': { id: 'tt0109830', type: 'movie', name: 'Forrest Gump', year: 1994 },
  'The Godfather': { id: 'tt0068646', type: 'movie', name: 'The Godfather', year: 1972 },
  'Schindlers List': { id: 'tt0108052', type: 'movie', name: 'Schindler\'s List', year: 1993 },
  'Spirited Away': { id: 'tt2454298', type: 'movie', name: 'Spirited Away', year: 2001 },
  'Parasite': { id: 'tt6751668', type: 'movie', name: 'Parasite', year: 2019 },
  'Everything Everywhere All at Once': { id: 'tt6710474', type: 'movie', name: 'Everything Everywhere All at Once', year: 2022 },
  'Game of Thrones': { id: 'tt0944947', type: 'series', name: 'Game of Thrones', year: 2011 },
  'Breaking Bad': { id: 'tt0903747', type: 'series', name: 'Breaking Bad', year: 2008 },
  'The Wire': { id: 'tt0306414', type: 'series', name: 'The Wire', year: 2002 },
  'Friends': { id: 'tt0108778', type: 'series', name: 'Friends', year: 1994 },
  'The Office': { id: 'tt0386676', type: 'series', name: 'The Office', year: 2005 },
  'Stranger Things': { id: 'tt4574334', type: 'series', name: 'Stranger Things', year: 2016 },
  'The Mandalorian': { id: 'tt8111088', type: 'series', name: 'The Mandalorian', year: 2019 },
  'Westworld': { id: 'tt0475784', type: 'series', name: 'Westworld', year: 2016 },
  'The Crown': { id: 'tt4786824', type: 'series', name: 'The Crown', year: 2016 },
  'Black Mirror': { id: 'tt2085059', type: 'series', name: 'Black Mirror', year: 2011 },
  'The Sopranos': { id: 'tt0141842', type: 'series', name: 'The Sopranos', year: 1999 },
  'The Simpsons': { id: 'tt0096697', type: 'series', name: 'The Simpsons', year: 1989 },
  'South Park': { id: 'tt0121955', type: 'series', name: 'South Park', year: 1997 },
  'Archer 2009': { id: 'tt1486217', type: 'series', name: 'Archer', year: 2009 },
  'Rick and Morty': { id: 'tt2861424', type: 'series', name: 'Rick and Morty', year: 2013 },
  'Batman': { id: 'tt0096895', type: 'movie', name: 'Batman', year: 1989 },
  'Batman Begins': { id: 'tt0372784', type: 'movie', name: 'Batman Begins', year: 2005 },
  'The Dark Knight Rises': { id: 'tt1345836', type: 'movie', name: 'The Dark Knight Rises', year: 2012 },
  'Halloween': { id: 'tt0077651', type: 'movie', name: 'Halloween', year: 1978 },
  'Star Wars': { id: 'tt0076759', type: 'movie', name: 'Star Wars', year: 1977 },
  'Star Wars Episode V The Empire Strikes Back': { id: 'tt0080684', type: 'movie', name: 'Star Wars: Episode V - The Empire Strikes Back', year: 1980 },
  'Alien': { id: 'tt0078748', type: 'movie', name: 'Alien', year: 1979 },
  'Aliens': { id: 'tt0090605', type: 'movie', name: 'Aliens', year: 1986 },
  'Terminator': { id: 'tt0088247', type: 'movie', name: 'The Terminator', year: 1984 },
  'Terminator 2 Judgment Day': { id: 'tt0103064', type: 'movie', name: 'Terminator 2: Judgment Day', year: 1991 },
  'Amelie': { id: 'tt0211915', type: 'movie', name: 'Amélie', year: 2001 },
  'City of God': { id: 'tt0317248', type: 'movie', name: 'City of God', year: 2002 },
  'Pan\'s Labyrinth': { id: 'tt0457430', type: 'movie', name: 'Pan\'s Labyrinth', year: 2006 },
  'The Lives of Others': { id: 'tt0405094', type: 'movie', name: 'The Lives of Others', year: 2006 },
  'Downfall': { id: 'tt0363163', type: 'movie', name: 'Downfall', year: 2004 },
  'Crouching Tiger Hidden Dragon': { id: 'tt0190332', type: 'movie', name: 'Crouching Tiger, Hidden Dragon', year: 2000 },
  'Oldboy': { id: 'tt0364569', type: 'movie', name: 'Oldboy', year: 2003 },
  'A Separation': { id: 'tt1832382', type: 'movie', name: 'A Separation', year: 2011 },
  '1917': { id: 'tt8579674', type: 'movie', name: '1917', year: 2019 },
  '300': { id: 'tt0416449', type: 'movie', name: '300', year: 2007 },
  'Se7en': { id: 'tt0114369', type: 'movie', name: 'Se7en', year: 1995 },
  '8 Mile': { id: 'tt0298203', type: 'movie', name: '8 Mile', year: 2002 },
  '12 Angry Men': { id: 'tt0050083', type: 'movie', name: '12 Angry Men', year: 1957 },
  '2001 A Space Odyssey': { id: 'tt0062622', type: 'movie', name: '2001: A Space Odyssey', year: 1968 },
  '1984': { id: 'tt0087803', type: 'movie', name: '1984', year: 1984 },
  '2012': { id: 'tt1190080', type: 'movie', name: '2012', year: 2009 },
};

function mockSearchCatalog(query) {
  const q = query.toLowerCase().trim();
  const results = [];
  
  for (const [key, value] of Object.entries(MOCK_CINEMETA)) {
    const name = value.name.toLowerCase();
    if (name.includes(q) || q.includes(name) || 
        name.split(' ').some(w => q.includes(w)) ||
        q.split(' ').some(w => name.includes(w))) {
      results.push(value);
    }
  }
  
  // Sort by relevance
  return results.sort((a, b) => {
    const aName = a.name.toLowerCase();
    const bName = b.name.toLowerCase();
    if (aName === q) return -1;
    if (bName === q) return 1;
    if (aName.startsWith(q)) return -1;
    if (bName.startsWith(q)) return 1;
    return 0;
  });
}

// =============================================================================
// Evaluation Functions
// =============================================================================

function createMockFetch() {
  return async (url) => ({
    ok: true,
    async json() {
      const match = url.match(/search=([^&]+)/);
      if (!match) return { metas: [] };
      const query = decodeURIComponent(match[1]);
      const results = mockSearchCatalog(query);
      return { metas: results };
    },
  });
}

function evaluateParser(sample, parsed) {
  const result = {
    titleExtracted: false,
    titleCorrect: false,
    yearExtracted: false,
    yearCorrect: false,
    seasonExtracted: false,
    episodeExtracted: false,
    mediaTypeCorrect: false,
    confidence: 0,
    failureReasons: [],
  };

  if (!parsed) {
    result.failureReasons.push('parse_failed');
    return result;
  }

  result.confidence = parsed.confidence;

  // Title evaluation
  if (parsed.parsed.title) {
    result.titleExtracted = true;
    const expectedTitle = sample.expected.title.toLowerCase();
    const actualTitle = parsed.parsed.title.toLowerCase();
    if (actualTitle === expectedTitle || 
        actualTitle.includes(expectedTitle) || 
        expectedTitle.includes(actualTitle) ||
        titleMatchQuality(parsed.parsed.title, sample.expected.title) !== 'none') {
      result.titleCorrect = true;
    } else {
      result.failureReasons.push('title_mismatch');
    }
  } else {
    result.failureReasons.push('title_missing');
  }

  // Year evaluation (movies)
  if (sample.expected.year) {
    if (parsed.parsed.year) {
      result.yearExtracted = true;
      if (parsed.parsed.year === sample.expected.year) {
        result.yearCorrect = true;
      } else {
        result.failureReasons.push('year_mismatch');
      }
    } else {
      result.failureReasons.push('year_missing');
    }
  }

  // Season/episode evaluation (TV)
  if (sample.expected.season) {
    if (parsed.parsed.season) {
      result.seasonExtracted = true;
    } else {
      result.failureReasons.push('season_missing');
    }
  }
  if (sample.expected.episode) {
    if (parsed.parsed.episode) {
      result.episodeExtracted = true;
    } else {
      result.failureReasons.push('episode_missing');
    }
  }

  // Media type evaluation
  if (sample.expected.type === 'pack') {
    // Packs are hard to detect, don't penalize
    result.mediaTypeCorrect = true;
  } else if (parsed.parsed.mediaType === sample.expected.type || 
             (sample.expected.type === 'movie' && parsed.parsed.mediaType === 'unknown')) {
    result.mediaTypeCorrect = true;
  } else {
    result.failureReasons.push('media_type_mismatch');
  }

  return result;
}

async function evaluateEnrichment(cache, sample, parsed) {
  const result = {
    matched: false,
    mediaId: null,
    confidence: 0,
    source: null,
    evidence: [],
    failureReasons: [],
  };

  // Store candidate
  cache.upsertCandidate({
    infoHash: sample.hash,
    fileIndex: null,
    filename: sample.filename,
    title: parsed?.parsed?.title || null,
  });

  // Store release attributes
  if (parsed) {
    storeReleaseAttributes(cache, {
      infoHash: sample.hash,
      fileIndex: null,
      filename: sample.filename,
      source: 'ptn-regex',
      confidence: parsed.confidence,
      parsed: parsed.parsed,
      evidence: parsed.evidence,
    });
  }

  // Run enrichment
  const mockFetch = createMockFetch();
  const enrichment = await enrichWithCinemeta(cache, cache.getCandidate(sample.hash, null), { fetchImpl: mockFetch });

  if (enrichment && enrichment.matches.length > 0) {
    const bestMatch = enrichment.matches[0];
    result.matched = true;
    result.mediaId = bestMatch.mediaId;
    result.confidence = bestMatch.confidence;
    result.source = enrichment.source;
    result.evidence = enrichment.evidence;

    // Store the enrichment
    enrichCandidate(cache, enrichment);
  } else {
    result.failureReasons.push('no_match');
  }

  return result;
}

// =============================================================================
// Main Evaluation
// =============================================================================

async function runEvaluation() {
  const cache = createDiscoveryCache();
  const report = {
    timestamp: new Date().toISOString(),
    summary: {
      totalSamples: 0,
      parserSuccess: 0,
      parserFailures: 0,
      enrichmentSuccess: 0,
      enrichmentFailures: 0,
    },
    parserMetrics: {
      titleExtracted: 0,
      titleCorrect: 0,
      yearExtracted: 0,
      yearCorrect: 0,
      seasonExtracted: 0,
      episodeExtracted: 0,
      mediaTypeCorrect: 0,
      avgConfidence: 0,
    },
    enrichmentMetrics: {
      matched: 0,
      unmatched: 0,
      avgConfidence: 0,
      bySource: {},
    },
    failureCategories: {
      parse_failed: [],
      title_missing: [],
      title_mismatch: [],
      year_missing: [],
      year_mismatch: [],
      season_missing: [],
      episode_missing: [],
      media_type_mismatch: [],
      no_match: [],
      ambiguous: [],
      foreign_language: [],
      pack_collection: [],
    },
    categoryResults: {},
    samples: [],
  };

  let totalConfidence = 0;
  let enrichmentConfidenceSum = 0;

  // Process each category
  for (const [category, samples] of Object.entries(SAMPLES)) {
    const categoryResult = {
      total: samples.length,
      parserSuccess: 0,
      enrichmentSuccess: 0,
      failures: [],
    };

    for (const sample of samples) {
      report.summary.totalSamples++;

      // Parse filename
      const parsed = parseFilename(sample.filename);
      const parserEval = evaluateParser(sample, parsed);

      // Track parser metrics
      if (parsed) {
        report.summary.parserSuccess++;
        categoryResult.parserSuccess++;
        totalConfidence += parsed.confidence;
        report.parserMetrics.avgConfidence = totalConfidence / report.summary.parserSuccess;
      } else {
        report.summary.parserFailures++;
      }

      if (parserEval.titleExtracted) report.parserMetrics.titleExtracted++;
      if (parserEval.titleCorrect) report.parserMetrics.titleCorrect++;
      if (parserEval.yearExtracted) report.parserMetrics.yearExtracted++;
      if (parserEval.yearCorrect) report.parserMetrics.yearCorrect++;
      if (parserEval.seasonExtracted) report.parserMetrics.seasonExtracted++;
      if (parserEval.episodeExtracted) report.parserMetrics.episodeExtracted++;
      if (parserEval.mediaTypeCorrect) report.parserMetrics.mediaTypeCorrect++;

      // Track failure categories
      for (const reason of parserEval.failureReasons) {
        if (report.failureCategories[reason]) {
          report.failureCategories[reason].push(sample.filename);
        }
      }

      // Categorize special cases
      if (category === 'foreign') {
        report.failureCategories.foreign_language.push(sample.filename);
      }
      if (category === 'packs') {
        report.failureCategories.pack_collection.push(sample.filename);
      }
      if (category === 'ambiguous') {
        report.failureCategories.ambiguous.push(sample.filename);
      }

      // Evaluate enrichment
      const enrichmentEval = await evaluateEnrichment(cache, sample, parsed);

      if (enrichmentEval.matched) {
        report.summary.enrichmentSuccess++;
        categoryResult.enrichmentSuccess++;
        report.enrichmentMetrics.matched++;
        enrichmentConfidenceSum += enrichmentEval.confidence;
        report.enrichmentMetrics.avgConfidence = enrichmentConfidenceSum / report.enrichmentMetrics.matched;
        report.enrichmentMetrics.bySource[enrichmentEval.source] = 
          (report.enrichmentMetrics.bySource[enrichmentEval.source] || 0) + 1;
      } else {
        report.summary.enrichmentFailures++;
        report.enrichmentMetrics.unmatched++;
        for (const reason of enrichmentEval.failureReasons) {
          if (report.failureCategories[reason]) {
            report.failureCategories[reason].push(sample.filename);
          }
        }
      }

      // Store sample result
      report.samples.push({
        category,
        filename: sample.filename,
        expected: sample.expected,
        parsed: parsed ? {
          title: parsed.parsed.title,
          year: parsed.parsed.year,
          season: parsed.parsed.season,
          episode: parsed.parsed.episode,
          mediaType: parsed.parsed.mediaType,
          confidence: parsed.confidence,
        } : null,
        parserEval,
        enrichmentEval,
      });
    }

    report.categoryResults[category] = categoryResult;
  }

  cache.close();
  return report;
}

// =============================================================================
// Report Generation
// =============================================================================

function generateReport(report) {
  const lines = [];

  lines.push('# Enrichment Effectiveness Evaluation Report');
  lines.push('');
  lines.push(`**Date:** ${report.timestamp}`);
  lines.push(`**Total Samples:** ${report.summary.totalSamples}`);
  lines.push('');

  // Executive Summary
  lines.push('## Executive Summary');
  lines.push('');
  lines.push('| Metric | Value | Rate |');
  lines.push('|--------|-------|------|');
  lines.push(`| Parser Success | ${report.summary.parserSuccess}/${report.summary.totalSamples} | ${((report.summary.parserSuccess / report.summary.totalSamples) * 100).toFixed(1)}% |`);
  lines.push(`| Enrichment Success | ${report.summary.enrichmentSuccess}/${report.summary.totalSamples} | ${((report.summary.enrichmentSuccess / report.summary.totalSamples) * 100).toFixed(1)}% |`);
  lines.push(`| Parser Avg Confidence | ${report.parserMetrics.avgConfidence.toFixed(3)} | - |`);
  lines.push(`| Enrichment Avg Confidence | ${report.enrichmentMetrics.avgConfidence.toFixed(3)} | - |`);
  lines.push('');

  // Parser Success Metrics
  lines.push('## 1. Parser Success Metrics');
  lines.push('');
  lines.push('| Field | Extracted | Correct | Rate |');
  lines.push('|-------|-----------|---------|------|');
  lines.push(`| Title | ${report.parserMetrics.titleExtracted}/${report.summary.totalSamples} | ${report.parserMetrics.titleCorrect}/${report.parserMetrics.titleExtracted} | ${((report.parserMetrics.titleExtracted / report.summary.totalSamples) * 100).toFixed(1)}% |`);
  lines.push(`| Year | ${report.parserMetrics.yearExtracted}/${report.summary.totalSamples} | ${report.parserMetrics.yearCorrect}/${report.parserMetrics.yearExtracted} | ${((report.parserMetrics.yearExtracted / report.summary.totalSamples) * 100).toFixed(1)}% |`);
  lines.push(`| Season | ${report.parserMetrics.seasonExtracted}/${report.summary.totalSamples} | - | ${((report.parserMetrics.seasonExtracted / report.summary.totalSamples) * 100).toFixed(1)}% |`);
  lines.push(`| Episode | ${report.parserMetrics.episodeExtracted}/${report.summary.totalSamples} | - | ${((report.parserMetrics.episodeExtracted / report.summary.totalSamples) * 100).toFixed(1)}% |`);
  lines.push(`| Media Type | ${report.parserMetrics.mediaTypeCorrect}/${report.summary.totalSamples} | - | ${((report.parserMetrics.mediaTypeCorrect / report.summary.totalSamples) * 100).toFixed(1)}% |`);
  lines.push('');

  // Identity Resolution
  lines.push('## 2. Identity Resolution');
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('|--------|-------|');
  lines.push(`| Matched | ${report.enrichmentMetrics.matched} |`);
  lines.push(`| Unmatched | ${report.enrichmentMetrics.unmatched} |`);
  lines.push(`| Avg Confidence | ${report.enrichmentMetrics.avgConfidence.toFixed(3)} |`);
  lines.push('');
  lines.push('### By Source');
  lines.push('');
  lines.push('| Source | Count |');
  lines.push('|--------|-------|');
  for (const [source, count] of Object.entries(report.enrichmentMetrics.bySource)) {
    lines.push(`| ${source} | ${count} |`);
  }
  lines.push('');

  // Category Breakdown
  lines.push('## 3. Category Breakdown');
  lines.push('');
  lines.push('| Category | Samples | Parser Success | Enrichment Success |');
  lines.push('|----------|---------|----------------|--------------------|');
  for (const [category, result] of Object.entries(report.categoryResults)) {
    lines.push(`| ${category} | ${result.total} | ${result.parserSuccess}/${result.total} (${((result.parserSuccess / result.total) * 100).toFixed(0)}%) | ${result.enrichmentSuccess}/${result.total} (${((result.enrichmentSuccess / result.total) * 100).toFixed(0)}%) |`);
  }
  lines.push('');

  // Failure Categories
  lines.push('## 4. Failure Categories');
  lines.push('');
  for (const [category, samples] of Object.entries(report.failureCategories)) {
    if (samples.length > 0) {
      lines.push(`### ${category} (${samples.length})`);
      lines.push('');
      for (const sample of samples.slice(0, 5)) {
        lines.push(`- ${sample}`);
      }
      if (samples.length > 5) {
        lines.push(`- ... and ${samples.length - 5} more`);
      }
      lines.push('');
    }
  }

  // Highest-Value Improvements
  lines.push('## 5. Highest-Value Improvements');
  lines.push('');

  // Calculate improvement opportunities
  const improvements = [];

  // Parser improvements
  const titleFailRate = 1 - (report.parserMetrics.titleExtracted / report.summary.totalSamples);
  if (titleFailRate > 0.05) {
    improvements.push({
      area: 'Parser Improvements',
      issue: 'Title extraction failures',
      impact: `${(titleFailRate * 100).toFixed(1)}% of samples`,
      recommendation: 'Improve title extraction for edge cases (numeric titles, special characters)',
      priority: titleFailRate > 0.1 ? 'HIGH' : 'MEDIUM',
    });
  }

  const yearFailRate = report.parserMetrics.titleExtracted > 0 ? 
    1 - (report.parserMetrics.yearExtracted / report.parserMetrics.titleExtracted) : 0;
  if (yearFailRate > 0.1) {
    improvements.push({
      area: 'Parser Improvements',
      issue: 'Year extraction failures',
      impact: `${(yearFailRate * 100).toFixed(1)}% of titled releases`,
      recommendation: 'Add year patterns for edge cases (year at start, year in parentheses)',
      priority: yearFailRate > 0.2 ? 'HIGH' : 'MEDIUM',
    });
  }

  // Alternate title support
  const foreignCount = report.failureCategories.foreign_language.length;
  if (foreignCount > 0) {
    improvements.push({
      area: 'Alternate Title Support',
      issue: 'Foreign language titles',
      impact: `${foreignCount} samples`,
      recommendation: 'Add TMDB/IMDb as enrichment source for better foreign title matching',
      priority: foreignCount > 5 ? 'HIGH' : 'MEDIUM',
    });
  }

  // Provider additions
  const ambiguousCount = report.failureCategories.ambiguous.length;
  if (ambiguousCount > 0) {
    improvements.push({
      area: 'Provider Additions',
      issue: 'Ambiguous titles (multiple matches)',
      impact: `${ambiguousCount} samples`,
      recommendation: 'Add TMDB for disambiguation (year + title matching)',
      priority: 'MEDIUM',
    });
  }

  // Pack/collection handling
  const packCount = report.failureCategories.pack_collection.length;
  if (packCount > 0) {
    improvements.push({
      area: 'Parser Improvements',
      issue: 'Pack/collection detection',
      impact: `${packCount} samples`,
      recommendation: 'Add patterns for detecting collections, trilogies, sagas',
      priority: 'LOW',
    });
  }

  // Enrichment failures
  const enrichmentFailRate = report.summary.enrichmentFailures / report.summary.totalSamples;
  if (enrichmentFailRate > 0.2) {
    improvements.push({
      area: 'Enrichment Sources',
      issue: 'High enrichment failure rate',
      impact: `${(enrichmentFailRate * 100).toFixed(1)}% of samples`,
      recommendation: 'Add TMDB as secondary enrichment source, improve title matching',
      priority: enrichmentFailRate > 0.3 ? 'HIGH' : 'MEDIUM',
    });
  }

  // Sort by priority
  improvements.sort((a, b) => {
    const priorityOrder = { HIGH: 0, MEDIUM: 1, LOW: 2 };
    return priorityOrder[a.priority] - priorityOrder[b.priority];
  });

  lines.push('| Priority | Area | Issue | Impact | Recommendation |');
  lines.push('|----------|------|-------|--------|----------------|');
  for (const imp of improvements) {
    lines.push(`| ${imp.priority} | ${imp.area} | ${imp.issue} | ${imp.impact} | ${imp.recommendation} |`);
  }
  lines.push('');

  // Detailed Sample Analysis
  lines.push('## 6. Detailed Sample Analysis');
  lines.push('');
  lines.push('### Parser Failures');
  lines.push('');
  for (const sample of report.samples.filter(s => s.parserEval.failureReasons.length > 0).slice(0, 10)) {
    lines.push(`- **${sample.filename}**`);
    lines.push(`  - Expected: ${JSON.stringify(sample.expected)}`);
    lines.push(`  - Parsed: ${JSON.stringify(sample.parsed)}`);
    lines.push(`  - Failures: ${sample.parserEval.failureReasons.join(', ')}`);
    lines.push('');
  }

  lines.push('### Enrichment Failures');
  lines.push('');
  for (const sample of report.samples.filter(s => !s.enrichmentEval.matched).slice(0, 10)) {
    lines.push(`- **${sample.filename}**`);
    lines.push(`  - Expected: ${JSON.stringify(sample.expected)}`);
    lines.push(`  - Parsed title: ${sample.parsed?.title || 'null'}`);
    lines.push(`  - Failures: ${sample.enrichmentEval.failureReasons.join(', ')}`);
    lines.push('');
  }

  return lines.join('\n');
}

// =============================================================================
// Run
// =============================================================================

async function main() {
  console.error('Running enrichment effectiveness evaluation...');
  const report = await runEvaluation();
  const markdown = generateReport(report);
  
  // Write report
  const reportPath = new URL('./ENRICHMENT-EVALUATION.md', import.meta.url);
  const { writeFileSync } = await import('node:fs');
  writeFileSync(reportPath, markdown, 'utf-8');
  
  console.error(`Report written to: ${reportPath.pathname}`);
  console.log(markdown);
}

main().catch(err => {
  console.error('Evaluation failed:', err);
  process.exit(1);
});
