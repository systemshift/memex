package transaction

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"
	"time"

	"memex/internal/memex/storage"
)

// ActionStore manages the history of actions in the graph
type ActionStore struct {
	store    *storage.MXStore // Reference to main storage
	file     *os.File         // Action log file
	mu       sync.RWMutex     // Mutex for thread safety
	lastHash [32]byte         // Hash of last action
}

// NewActionStore creates a new action store
func NewActionStore(store *storage.MXStore) (*ActionStore, error) {
	// Create actions directory next to .mx file
	mxPath := store.Path()
	actionsPath := filepath.Join(filepath.Dir(mxPath), ".actions")
	if err := os.MkdirAll(actionsPath, 0755); err != nil {
		return nil, fmt.Errorf("creating actions directory: %w", err)
	}

	// Open actions log file
	logPath := filepath.Join(actionsPath, "log")
	file, err := os.OpenFile(logPath, os.O_RDWR|os.O_CREATE|os.O_APPEND, 0644)
	if err != nil {
		return nil, fmt.Errorf("opening action log: %w", err)
	}

	as := &ActionStore{
		store: store,
		file:  file,
	}

	// Read last hash if file exists
	if info, err := file.Stat(); err == nil && info.Size() > 0 {
		if lastAction, err := as.readLastAction(); err == nil {
			as.lastHash, _ = lastAction.Hash()
		}
	}

	return as, nil
}

// Close closes the action store
func (as *ActionStore) Close() error {
	as.mu.Lock()
	defer as.mu.Unlock()

	if err := as.file.Sync(); err != nil {
		return fmt.Errorf("syncing action log: %w", err)
	}

	if err := as.file.Close(); err != nil {
		return fmt.Errorf("closing action log: %w", err)
	}

	return nil
}

// RecordAction records a new action in the store
func (as *ActionStore) RecordAction(actionType ActionType, payload map[string]any) error {
	as.mu.Lock()
	defer as.mu.Unlock()

	// Create new action
	action := &Action{
		Type:      actionType,
		Payload:   payload,
		Timestamp: time.Now(),
		PrevHash:  as.lastHash,
	}

	// Calculate state hash based on affected nodes/edges
	stateHash, err := as.calculateStateHash(action)
	if err != nil {
		return fmt.Errorf("calculating state hash: %w", err)
	}
	action.StateHash = stateHash

	// Write action to log
	if err := as.writeAction(action); err != nil {
		return fmt.Errorf("writing action: %w", err)
	}

	// Update last hash
	as.lastHash, err = action.Hash()
	if err != nil {
		return fmt.Errorf("calculating action hash: %w", err)
	}

	return nil
}

// GetHistory returns all actions in chronological order
func (as *ActionStore) GetHistory() ([]*Action, error) {
	as.mu.RLock()
	defer as.mu.RUnlock()

	var actions []*Action

	// Seek to start of file
	if _, err := as.file.Seek(0, io.SeekStart); err != nil {
		return nil, fmt.Errorf("seeking to start: %w", err)
	}

	// Read actions until EOF
	for {
		action, err := as.readAction()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("reading action: %w", err)
		}
		actions = append(actions, action)
	}

	return actions, nil
}

// VerifyHistory verifies the entire action history
func (as *ActionStore) VerifyHistory() (bool, error) {
	actions, err := as.GetHistory()
	if err != nil {
		return false, fmt.Errorf("getting history: %w", err)
	}

	var prevAction *Action
	for _, action := range actions {
		valid, err := action.Verify(prevAction)
		if err != nil {
			return false, fmt.Errorf("verifying action: %w", err)
		}
		if !valid {
			return false, nil
		}
		prevAction = action
	}

	return true, nil
}

// Internal methods

func (as *ActionStore) writeAction(action *Action) error {
	// Marshal action to JSON
	data, err := json.Marshal(action)
	if err != nil {
		return fmt.Errorf("marshaling action: %w", err)
	}

	// Write length prefix
	if err := binary.Write(as.file, binary.LittleEndian, uint32(len(data))); err != nil {
		return fmt.Errorf("writing length: %w", err)
	}

	// Write action data
	if _, err := as.file.Write(data); err != nil {
		return fmt.Errorf("writing data: %w", err)
	}

	return nil
}

func (as *ActionStore) readAction() (*Action, error) {
	// Read length prefix
	var length uint32
	if err := binary.Read(as.file, binary.LittleEndian, &length); err != nil {
		return nil, err
	}

	// Read action data
	data := make([]byte, length)
	if _, err := io.ReadFull(as.file, data); err != nil {
		return nil, err
	}

	// Unmarshal action
	var action Action
	if err := json.Unmarshal(data, &action); err != nil {
		return nil, fmt.Errorf("unmarshaling action: %w", err)
	}

	return &action, nil
}

func (as *ActionStore) readLastAction() (*Action, error) {
	// Get file size
	info, err := as.file.Stat()
	if err != nil {
		return nil, fmt.Errorf("getting file info: %w", err)
	}

	// Read backwards until we find a valid action
	pos := info.Size()
	for pos > 0 {
		// Try to read length prefix
		if _, err := as.file.Seek(pos-4, io.SeekStart); err != nil {
			return nil, fmt.Errorf("seeking to length: %w", err)
		}

		var length uint32
		if err := binary.Read(as.file, binary.LittleEndian, &length); err != nil {
			pos -= 1
			continue
		}

		// Check if this could be a valid action
		if length > 0 && length < uint32(pos) {
			// Try to read action
			if _, err := as.file.Seek(pos-4-int64(length), io.SeekStart); err != nil {
				pos -= 1
				continue
			}

			action, err := as.readAction()
			if err == nil {
				return action, nil
			}
		}

		pos -= 1
	}

	return nil, fmt.Errorf("no valid actions found")
}

func (as *ActionStore) calculateStateHash(action *Action) ([32]byte, error) {
	// This is a placeholder - actual implementation would:
	// 1. Identify affected nodes/edges based on action type and payload
	// 2. Get their current state from storage
	// 3. Calculate combined hash of their state
	return [32]byte{}, nil
}