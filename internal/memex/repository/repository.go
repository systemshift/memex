package repository

import (
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"sync"
	"time"

	"github.com/systemshift/memex/internal/memex/core"
	"github.com/systemshift/memex/internal/memex/storage/rabin"
	"github.com/systemshift/memex/internal/memex/storage/store"
	"github.com/systemshift/memex/internal/memex/transaction"
)

// Magic number for .mx files
const MagicNumber = "MEMEX01"

// Header represents the .mx file header (128 bytes)
type Header struct {
	Magic         [7]byte  // "MEMEX01"
	FormatVersion uint8    // Repository format version (major)
	FormatMinor   uint8    // Repository format version (minor)
	MemexVersion  [32]byte // Memex version that created the repository
	Created       int64    // Creation timestamp (Unix seconds)
	Modified      int64    // Last modified timestamp (Unix seconds)
	NodeCount     uint32   // Number of nodes
	EdgeCount     uint32   // Number of edges
	NodeIndex     uint64   // Offset to node index
	EdgeIndex     uint64   // Offset to edge index
	Reserved      [31]byte // Future use
}

// Repository represents a content repository
type Repository struct {
	path    string
	file    *os.File
	header  Header
	store   *store.ChunkStore
	txStore *transaction.ActionStore
	lockMgr sync.Mutex
}

// Ensure Repository implements required interfaces
var (
	_ transaction.Storage = (*Repository)(nil)
	_ core.Repository     = (*Repository)(nil)
)

// Create creates a new repository at the given path
func Create(path string) (*Repository, error) {
	// Create file
	file, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE|os.O_EXCL, 0644)
	if err != nil {
		return nil, fmt.Errorf("creating repository file: %w", err)
	}

	// Initialize header
	now := time.Now().UTC().Unix()
	header := Header{
		FormatVersion: core.CurrentVersion.Major,
		FormatMinor:   core.CurrentVersion.Minor,
		Created:       now,
		Modified:      now,
		NodeCount:     0,
		EdgeCount:     0,
	}
	copy(header.Magic[:], MagicNumber)
	copy(header.MemexVersion[:], []byte(core.CurrentVersion.String()))

	// Write header
	if err := binary.Write(file, binary.LittleEndian, &header); err != nil {
		file.Close()
		return nil, fmt.Errorf("writing header: %w", err)
	}

	// Create repository instance
	repo := &Repository{
		path:   path,
		file:   file,
		header: header,
	}

	// Create transaction store
	txStore, err := transaction.NewActionStore(repo)
	if err != nil {
		file.Close()
		return nil, fmt.Errorf("creating transaction store: %w", err)
	}
	repo.txStore = txStore

	// Create chunker
	chunker := rabin.NewChunker()

	// Create store using the same file
	store, err := store.NewStore(path, chunker, txStore)
	if err != nil {
		file.Close()
		return nil, fmt.Errorf("creating store: %w", err)
	}
	repo.store = store

	return repo, nil
}

// Open opens an existing repository
func Open(path string) (*Repository, error) {
	// Open file
	file, err := os.OpenFile(path, os.O_RDWR, 0644)
	if err != nil {
		return nil, fmt.Errorf("opening repository file: %w", err)
	}

	// Read header
	var header Header
	if err := binary.Read(file, binary.LittleEndian, &header); err != nil {
		file.Close()
		return nil, fmt.Errorf("reading header: %w", err)
	}

	// Verify magic number and version compatibility
	if string(header.Magic[:]) != MagicNumber {
		file.Close()
		return nil, fmt.Errorf("invalid repository file")
	}

	// Check format version compatibility
	repoVersion := core.RepositoryVersion{
		Major: header.FormatVersion,
		Minor: header.FormatMinor,
	}

	if !core.CurrentVersion.IsCompatible(repoVersion) {
		file.Close()
		return nil, fmt.Errorf("incompatible repository version %s (current version: %s)",
			repoVersion.String(), core.CurrentVersion.String())
	}

	// Create repository instance
	repo := &Repository{
		path:   path,
		file:   file,
		header: header,
	}

	// Create transaction store
	txStore, err := transaction.NewActionStore(repo)
	if err != nil {
		file.Close()
		return nil, fmt.Errorf("creating transaction store: %w", err)
	}
	repo.txStore = txStore

	// Create chunker
	chunker := rabin.NewChunker()

	// Open store using the same file
	store, err := store.NewStore(path, chunker, txStore)
	if err != nil {
		file.Close()
		return nil, fmt.Errorf("opening store: %w", err)
	}
	repo.store = store

	return repo, nil
}

// Path returns the repository path (implements transaction.Storage)
func (r *Repository) Path() string {
	return r.path
}

// GetFile returns the underlying file for transaction storage (implements transaction.Storage)
func (r *Repository) GetFile() interface{} {
	return r.file
}

// GetLockManager returns the lock manager for transaction storage (implements transaction.Storage)
func (r *Repository) GetLockManager() interface{} {
	return &r.lockMgr
}

// GetContent retrieves content from the repository
func (r *Repository) GetContent(id string) ([]byte, error) {
	hashBytes, err := hex.DecodeString(id)
	if err != nil {
		return nil, fmt.Errorf("parsing content ID: %w", err)
	}
	return r.store.Get([][]byte{hashBytes})
}

// GetNode retrieves a node from the repository
func (r *Repository) GetNode(id string) (*core.Node, error) {
	var data []byte
	var err error

	// Try getting node data directly first
	data, err = r.store.Get([][]byte{[]byte(id)})
	if err != nil {
		// If that fails, try hex decoding if it's a hex string
		if len(id) == 64 { // Length of a hex-encoded SHA-256 hash
			if hashBytes, decodeErr := hex.DecodeString(id); decodeErr == nil {
				data, err = r.store.Get([][]byte{hashBytes})
				if err != nil {
					return nil, fmt.Errorf("getting node with hex ID: %w", err)
				}
			}
		} else {
			return nil, fmt.Errorf("getting node: %w", err)
		}
	}

	// Parse node
	var node core.Node
	if err := json.Unmarshal(data, &node); err != nil {
		// If parsing fails, try wrapping the data in a basic node structure
		node = core.Node{
			Content: data,
			Meta:    make(map[string]interface{}),
		}
	}

	// Ensure node has an ID and metadata
	node.ID = id
	if node.Meta == nil {
		node.Meta = make(map[string]interface{})
	}

	return &node, nil
}

// AddNode adds a node to the repository
func (r *Repository) AddNode(content []byte, nodeType string, meta map[string]interface{}) (string, error) {
	// Store content first to get chunks
	chunks, err := r.store.Put(content)
	if err != nil {
		return "", fmt.Errorf("storing content: %w", err)
	}

	// Create node
	now := time.Now().UTC()
	node := &core.Node{
		Type:     nodeType,
		Content:  content,
		Meta:     meta,
		Created:  now,
		Modified: now,
	}

	// Initialize metadata if nil
	if node.Meta == nil {
		node.Meta = make(map[string]interface{})
	} else {
		// Deep copy metadata
		metaCopy := make(map[string]interface{})
		metaJSON, err := json.Marshal(meta)
		if err != nil {
			return "", fmt.Errorf("marshaling metadata: %w", err)
		}
		if err := json.Unmarshal(metaJSON, &metaCopy); err != nil {
			return "", fmt.Errorf("unmarshaling metadata: %w", err)
		}
		node.Meta = metaCopy
	}

	// Add chunks to metadata
	chunkHashes := make([]string, len(chunks))
	for i, chunk := range chunks {
		chunkHashes[i] = hex.EncodeToString(chunk)
	}
	node.Meta["chunks"] = chunkHashes

	// Store node data
	data, err := json.Marshal(node)
	if err != nil {
		return "", fmt.Errorf("marshaling node: %w", err)
	}

	// Store in chunk store
	nodeChunks, err := r.store.Put(data)
	if err != nil {
		return "", fmt.Errorf("storing node: %w", err)
	}

	// Use first chunk hash as node ID
	if len(nodeChunks) == 0 {
		return "", fmt.Errorf("no chunks generated for node")
	}
	node.ID = hex.EncodeToString(nodeChunks[0])

	// Update header
	r.header.NodeCount++
	r.header.Modified = time.Now().UTC().Unix()
	if err := r.updateHeader(); err != nil {
		return "", fmt.Errorf("updating header: %w", err)
	}

	// Record action
	if err := r.txStore.RecordAction(transaction.ActionAddNode, map[string]any{
		"id":   node.ID,
		"type": nodeType,
		"meta": meta,
	}); err != nil {
		return "", fmt.Errorf("recording action: %w", err)
	}

	return node.ID, nil
}

// AddNodeWithID adds a node with a specific ID
func (r *Repository) AddNodeWithID(id string, content []byte, nodeType string, meta map[string]interface{}) error {
	// Store content first to get chunks
	chunks, err := r.store.Put(content)
	if err != nil {
		return fmt.Errorf("storing content: %w", err)
	}

	// Create node
	now := time.Now().UTC()
	node := &core.Node{
		ID:       id,
		Type:     nodeType,
		Content:  content,
		Meta:     meta,
		Created:  now,
		Modified: now,
	}

	// Initialize metadata if nil
	if node.Meta == nil {
		node.Meta = make(map[string]interface{})
	} else {
		// Deep copy metadata
		metaCopy := make(map[string]interface{})
		metaJSON, err := json.Marshal(meta)
		if err != nil {
			return fmt.Errorf("marshaling metadata: %w", err)
		}
		if err := json.Unmarshal(metaJSON, &metaCopy); err != nil {
			return fmt.Errorf("unmarshaling metadata: %w", err)
		}
		node.Meta = metaCopy
	}

	// Add chunks to metadata
	chunkHashes := make([]string, len(chunks))
	for i, chunk := range chunks {
		chunkHashes[i] = hex.EncodeToString(chunk)
	}
	node.Meta["chunks"] = chunkHashes

	// Store node data
	data, err := json.Marshal(node)
	if err != nil {
		return fmt.Errorf("marshaling node: %w", err)
	}

	// Store in chunk store with specific ID
	if err := r.store.PutWithID(id, data); err != nil {
		return fmt.Errorf("storing node: %w", err)
	}

	// Update header
	r.header.NodeCount++
	r.header.Modified = time.Now().UTC().Unix()
	if err := r.updateHeader(); err != nil {
		return fmt.Errorf("updating header: %w", err)
	}

	// Record action
	if err := r.txStore.RecordAction(transaction.ActionAddNode, map[string]any{
		"id":   id,
		"type": nodeType,
		"meta": meta,
	}); err != nil {
		return fmt.Errorf("recording action: %w", err)
	}

	return nil
}

// ListNodes returns a list of all node IDs
func (r *Repository) ListNodes() ([]string, error) {
	chunks, err := r.store.ListChunks()
	if err != nil {
		return nil, fmt.Errorf("listing chunks: %w", err)
	}

	ids := make([]string, len(chunks))
	for i, chunk := range chunks {
		ids[i] = hex.EncodeToString(chunk)
	}
	return ids, nil
}

// DeleteNode removes a node and its associated links
func (r *Repository) DeleteNode(id string) error {
	// Get node first to get chunk references
	node, err := r.GetNode(id)
	if err != nil {
		return fmt.Errorf("getting node: %w", err)
	}

	// Get associated links before deleting node
	links, err := r.GetLinks(id)
	if err != nil {
		return fmt.Errorf("getting links: %w", err)
	}

	// Delete all associated links first
	for _, link := range links {
		if err := r.DeleteLink(link.Source, link.Target, link.Type); err != nil {
			return fmt.Errorf("deleting link: %w", err)
		}
	}

	// Delete content chunks if they exist in metadata
	if chunks, ok := node.Meta["chunks"].([]interface{}); ok {
		for _, chunk := range chunks {
			if chunkStr, ok := chunk.(string); ok {
				hashBytes, err := hex.DecodeString(chunkStr)
				if err != nil {
					continue
				}
				if err := r.store.Delete([][]byte{hashBytes}); err != nil {
					return fmt.Errorf("deleting content chunk: %w", err)
				}
			}
		}
	}

	// Delete node
	if err := r.store.Delete([][]byte{[]byte(id)}); err != nil {
		return fmt.Errorf("deleting node: %w", err)
	}

	// Update header
	if r.header.NodeCount > 0 {
		r.header.NodeCount--
	}
	r.header.Modified = time.Now().UTC().Unix()
	if err := r.updateHeader(); err != nil {
		return fmt.Errorf("updating header: %w", err)
	}

	// Record action
	if err := r.txStore.RecordAction(transaction.ActionDeleteNode, map[string]any{
		"id": id,
	}); err != nil {
		return fmt.Errorf("recording action: %w", err)
	}

	return nil
}

// AddLink creates a link between nodes
func (r *Repository) AddLink(source, target, linkType string, meta map[string]interface{}) error {
	// Verify nodes exist
	if _, err := r.GetNode(source); err != nil {
		return fmt.Errorf("getting source node: %w", err)
	}
	if _, err := r.GetNode(target); err != nil {
		return fmt.Errorf("getting target node: %w", err)
	}

	// Create link
	now := time.Now().UTC()
	link := &core.Link{
		Source:   source,
		Target:   target,
		Type:     linkType,
		Meta:     meta,
		Created:  now,
		Modified: now,
	}

	// Deep copy metadata
	if meta != nil {
		metaCopy := make(map[string]interface{})
		metaJSON, err := json.Marshal(meta)
		if err != nil {
			return fmt.Errorf("marshaling metadata: %w", err)
		}
		if err := json.Unmarshal(metaJSON, &metaCopy); err != nil {
			return fmt.Errorf("unmarshaling metadata: %w", err)
		}
		link.Meta = metaCopy
	}

	// Store link data
	data, err := json.Marshal(link)
	if err != nil {
		return fmt.Errorf("marshaling link: %w", err)
	}

	// Store in chunk store
	_, err = r.store.Put(data)
	if err != nil {
		return fmt.Errorf("storing link: %w", err)
	}

	// Update header
	r.header.EdgeCount++
	r.header.Modified = time.Now().UTC().Unix()
	if err := r.updateHeader(); err != nil {
		return fmt.Errorf("updating header: %w", err)
	}

	// Record action
	if err := r.txStore.RecordAction(transaction.ActionAddLink, map[string]any{
		"source": source,
		"target": target,
		"type":   linkType,
		"meta":   meta,
	}); err != nil {
		return fmt.Errorf("recording action: %w", err)
	}

	return nil
}

// GetLinks returns all links for a node
func (r *Repository) GetLinks(nodeID string) ([]*core.Link, error) {
	// List all chunks
	chunks, err := r.store.ListChunks()
	if err != nil {
		return nil, fmt.Errorf("listing chunks: %w", err)
	}

	// Filter and parse links
	var links []*core.Link
	for _, chunk := range chunks {
		// Get chunk data
		data, err := r.store.Get([][]byte{chunk})
		if err != nil {
			continue
		}

		// Try to parse as link
		var link core.Link
		if err := json.Unmarshal(data, &link); err != nil {
			continue
		}

		// Check if link is related to node
		if link.Source == nodeID || link.Target == nodeID {
			links = append(links, &link)
		}
	}

	// Sort links by timestamp
	sort.Slice(links, func(i, j int) bool {
		if links[i].Created.Equal(links[j].Created) {
			orderI, okI := links[i].Meta["order"].(float64)
			orderJ, okJ := links[j].Meta["order"].(float64)
			if okI && okJ {
				return orderI < orderJ
			}
		}
		return links[i].Created.Before(links[j].Created)
	})

	return links, nil
}

// DeleteLink removes a link
func (r *Repository) DeleteLink(source, target, linkType string) error {
	// List all chunks
	chunks, err := r.store.ListChunks()
	if err != nil {
		return fmt.Errorf("listing chunks: %w", err)
	}

	// Find and delete matching link
	for _, chunk := range chunks {
		// Get chunk data
		data, err := r.store.Get([][]byte{chunk})
		if err != nil {
			continue
		}

		// Try to parse as link
		var link core.Link
		if err := json.Unmarshal(data, &link); err != nil {
			continue
		}

		// Check if this is the link to delete
		if link.Source == source && link.Target == target && link.Type == linkType {
			if err := r.store.Delete([][]byte{chunk}); err != nil {
				return fmt.Errorf("deleting link: %w", err)
			}

			// Update header
			if r.header.EdgeCount > 0 {
				r.header.EdgeCount--
			}
			r.header.Modified = time.Now().UTC().Unix()
			if err := r.updateHeader(); err != nil {
				return fmt.Errorf("updating header: %w", err)
			}

			// Record action
			if err := r.txStore.RecordAction(transaction.ActionDeleteLink, map[string]any{
				"source": source,
				"target": target,
				"type":   linkType,
			}); err != nil {
				return fmt.Errorf("recording action: %w", err)
			}

			return nil
		}
	}

	return nil
}

// Close closes the repository
func (r *Repository) Close() error {
	if err := r.store.Close(); err != nil {
		return fmt.Errorf("closing store: %w", err)
	}
	if err := r.txStore.Close(); err != nil {
		return fmt.Errorf("closing transaction store: %w", err)
	}
	return r.file.Close()
}

// Internal methods

func (r *Repository) updateHeader() error {
	// Seek to start of file
	if _, err := r.file.Seek(0, 0); err != nil {
		return fmt.Errorf("seeking to header: %w", err)
	}

	// Write header
	if err := binary.Write(r.file, binary.LittleEndian, &r.header); err != nil {
		return fmt.Errorf("writing header: %w", err)
	}

	// Sync to disk
	return r.file.Sync()
}
