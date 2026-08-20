/**
 * LZString Decoder
 *
 * Pure JavaScript implementation of lz-string's decompressFromEncodedURIComponent.
 * Used for decoding DMM hashlist payloads.
 */

/**
 * Decode LZString-compressed URI component string.
 * @param {string} encoded - LZString-encoded URI component
 * @returns {string|null} Decompressed string or null on failure
 */
export function decompressFromEncodedURIComponent(encoded) {
  if (!encoded || typeof encoded !== 'string') return null;

  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+-$';
  const reverseDic = {};
  for (let i = 0; i < alphabet.length; i++) {
    reverseDic[alphabet[i]] = i;
  }

  const getBaseValue = (char) => reverseDic[char] ?? 0;

  try {
    const length = encoded.length;
    const resetValue = 32;
    let dataIndex = 0;

    const getNextValue = (index) => {
      if (index >= length) return 0;
      return getBaseValue(encoded[index]);
    };

    let dataVal = getNextValue(0);
    let dataPosition = resetValue;

    const readBits = (bitCount) => {
      let bits = 0;
      let power = 1;
      const maxPower = 1 << bitCount;

      while (power !== maxPower) {
        const resb = dataVal & dataPosition;
        dataPosition >>= 1;
        if (dataPosition === 0) {
          dataPosition = resetValue;
          dataIndex++;
          dataVal = getNextValue(dataIndex);
        }
        if (resb > 0) bits |= power;
        power <<= 1;
      }
      return bits;
    };

    const dictionary = { 0: '', 1: '', 2: '' };
    let dictSize = 4;
    let numBits = 3;
    let enlargeIn = 4;

    const nextCode = readBits(2);
    let c;
    if (nextCode === 0) {
      c = String.fromCharCode(readBits(8));
    } else if (nextCode === 1) {
      c = String.fromCharCode(readBits(16));
    } else if (nextCode === 2) {
      return '';
    } else {
      return null;
    }

    dictionary[3] = c;
    let w = c;
    const result = [c];

    const decBuffer = (count) => {
      let i = 0;
      while (i < count) {
        if (dataIndex >= length) return 0;
        dataVal = (dataVal << 8) | getBaseValue(encoded[dataIndex]);
        dataIndex++;
        i++;
      }
      return 1;
    };

    const addToStringDictionary = (s) => {
      dictionary[dictSize] = s;
      dictSize++;
    };

    const enlargeDictionary = () => {
      numBits++;
      enlargeIn = 1 << numBits;
    };

    const enlargeE_in = () => {
      enlargeIn--;
      if (enlargeIn === 0) {
        enlargeDictionary();
      }
    };

    while (true) {
      const code = readBits(numBits);
      let charCode;

      if (code === 0) {
        charCode = readBits(8);
        if (!charCode) break;
        c = String.fromCharCode(charCode);
      } else if (code === 1) {
        charCode = readBits(16);
        if (!charCode) break;
        c = String.fromCharCode(charCode);
      } else if (code === 2) {
        return result.join('');
      } else {
        c = null;
      }

      let entry;
      if (code < dictSize) {
        entry = dictionary[code];
      } else {
        if (code === dictSize) {
          entry = w + w[0];
        } else {
          return null;
        }
      }

      result.push(entry);
      addToStringDictionary(w + entry[0]);
      w = entry;
      enlargeE_in();

      if (enlargeIn === 1) {
        enlargeDictionary();
      }
    }

    return result.join('');
  } catch (error) {
    return null;
  }
}

/**
 * Compress string to LZString URI component format.
 * @param {string} uncompressed - String to compress
 * @returns {string|null} Compressed string or null on failure
 */
export function compressToEncodedURIComponent(uncompressed) {
  if (!uncompressed) return null;

  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+-$';
  const getCharFromInt = (n) => alphabet[n];

  const dictionary = {};
  let dictSize = 3;
  let numBits = 2;
  let enlargeIn = 4;
  let entry = '';
  const result = [];

  const resizeDictionary = () => {
    numBits++;
    enlargeIn = 1 << numBits;
  };

  const addToDictionary = (c) => {
    dictionary[c] = dictSize++;
  };

  for (const c of uncompressed) {
    if (!dictionary[c]) {
      addToDictionary(c);
    }
    const wc = entry + c;
    if (dictionary[wc]) {
      entry = wc;
    } else {
      const w = dictionary[entry];
      if (w === undefined) {
        // First character
        const cc = entry.charCodeAt(0);
        if (cc < 256) {
          for (let i = 0; i < numBits; i++) {
            result.push(getCharFromInt(0));
          }
          const value = cc;
          for (let i = 0; i < 8; i++) {
            result.push(getCharFromInt(value & 1));
            value >>= 1;
          }
        } else {
          for (let i = 0; i < numBits; i++) {
            result.push(getCharFromInt(0));
          }
          const value = cc;
          for (let i = 0; i < 16; i++) {
            result.push(getCharFromInt(value & 1));
            value >>= 1;
          }
        }
        resizeDictionary();
        addToDictionary(c);
      } else {
        const wVal = w;
        const bits = [];
        let v = wVal;
        for (let i = 0; i < numBits; i++) {
          bits.push(v & 1);
          v >>= 1;
        }
        while (bits.length < numBits) bits.push(0);
        result.push(...bits.reverse().map(getCharFromInt));

        const cVal = c.charCodeAt(0);
        if (cVal < 256) {
          const bits = [];
          let v = cVal;
          for (let i = 0; i < 8; i++) {
            bits.push(v & 1);
            v >>= 1;
          }
          while (bits.length < 8) bits.push(0);
          result.push(...bits.reverse().map(getCharFromInt));
        } else {
          return null; // Non-ASCII not supported for simplicity
        }
        resizeDictionary();
      }
      entry = c;
      enlargeIn--;
      if (enlargeIn === 0) {
        resizeDictionary();
      }
    }
  }

  if (entry) {
    const w = dictionary[entry];
    const wVal = w;
    const bits = [];
    let v = wVal;
    for (let i = 0; i < numBits; i++) {
      bits.push(v & 1);
      v >>= 1;
    }
    while (bits.length < numBits) bits.push(0);
    result.push(...bits.reverse().map(getCharFromInt));
  }

  // End marker
  result.push(getCharFromInt(2));

  // Pad to multiple of 5
  while (result.length % 5 !== 0) {
    result.push(getCharFromInt(0));
  }

  return result.join('');
}
