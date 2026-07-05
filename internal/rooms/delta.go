package rooms

import (
	"encoding/base64"
	"encoding/binary"
	"sort"
	"strconv"
	"strings"
)

// This file implements the shared client/server delta byte format pinned in
// the contract §2:
//
//   Per chunk: a sequence of little-endian 3-byte records: u16 blockIndex
//   ((y*16+z)*16+x, 0..24575) + u8 blockId. Later records for the same index
//   win; the server compacts on flush to at most one record per index, in
//   ascending index order. Wire/dump encoding is base64 of the record blob.
//   An empty blob means the delta was removed (chunk back to pure-seed
//   state) — the server deletes the row.
//
// In memory, an instance keeps deltas as map[chunkKey]map[uint16]uint8 (per
// the contract's exact phrasing for Instance state) so random-access
// overwrite-by-index is O(1); compaction to the ascending, one-record-per-
// index wire format happens only when a chunk is actually flushed.

// recordSize is the byte width of one (index,id) delta record.
const recordSize = 3

// maxBlockIndex is one past the highest valid in-chunk block index (16*96*16).
const maxBlockIndex = 16 * 96 * 16

// chunkKey formats a chunk coordinate as the "cx,cz" string used as the map
// key everywhere in the wire protocol (welcome.deltas, world_deltas rows).
func chunkKey(cx, cz int) string {
	return strconv.Itoa(cx) + "," + strconv.Itoa(cz)
}

// parseChunkKey parses a "cx,cz" string back into its two integers.
func parseChunkKey(key string) (cx, cz int, ok bool) {
	i := strings.IndexByte(key, ',')
	if i < 0 {
		return 0, 0, false
	}
	cxv, err1 := strconv.Atoi(strings.TrimSpace(key[:i]))
	czv, err2 := strconv.Atoi(strings.TrimSpace(key[i+1:]))
	if err1 != nil || err2 != nil {
		return 0, 0, false
	}
	return cxv, czv, true
}

// decodeRecords parses a raw (non-base64) packed-record blob into an
// index->id map, applying "later records for the same index win" as it
// scans (so out-of-order overlapping edits already compact correctly on
// decode, independent of write order). Malformed trailing bytes (a length
// not a multiple of recordSize) are ignored past the last complete record —
// defensive against truncated storage, never a panic.
func decodeRecords(blob []byte) map[uint16]uint8 {
	out := make(map[uint16]uint8)
	n := len(blob) / recordSize
	for i := 0; i < n; i++ {
		off := i * recordSize
		idx := binary.LittleEndian.Uint16(blob[off : off+2])
		id := blob[off+2]
		if int(idx) >= maxBlockIndex {
			continue // defensive: never trust an out-of-range index from storage
		}
		out[idx] = id
	}
	return out
}

// encodeRecords compacts an index->id map into the canonical wire format:
// at most one record per index, ascending index order.
func encodeRecords(m map[uint16]uint8) []byte {
	if len(m) == 0 {
		return nil
	}
	idxs := make([]uint16, 0, len(m))
	for idx := range m {
		idxs = append(idxs, idx)
	}
	sort.Slice(idxs, func(i, j int) bool { return idxs[i] < idxs[j] })
	out := make([]byte, 0, len(idxs)*recordSize)
	var tmp [2]byte
	for _, idx := range idxs {
		binary.LittleEndian.PutUint16(tmp[:], idx)
		out = append(out, tmp[0], tmp[1], m[idx])
	}
	return out
}

// decodeAllDeltas turns the {"cx,cz": rawBlob} map returned by
// WorldStore.GetDeltas into the in-memory per-chunk index->id form an
// Instance keeps. Keys that fail to parse as "cx,cz" are skipped (defensive
// against corrupt storage — never fatal).
func decodeAllDeltas(blobs map[string][]byte) map[string]map[uint16]uint8 {
	out := make(map[string]map[uint16]uint8, len(blobs))
	for key, blob := range blobs {
		if _, _, ok := parseChunkKey(key); !ok {
			continue
		}
		out[key] = decodeRecords(blob)
	}
	return out
}

// base64Encode/base64Decode wrap the wire encoding used both for the
// welcome.deltas payload (client-facing) and for the raw bytea storage isn't
// base64 (Postgres bytea is binary) — see worlds.Store which owns the raw
// column; this package only ever produces/consumes the compacted []byte
// records for storage and the base64 string form for the WS wire.
func base64Encode(raw []byte) string { return base64.StdEncoding.EncodeToString(raw) }

func base64Decode(s string) ([]byte, error) { return base64.StdEncoding.DecodeString(s) }
