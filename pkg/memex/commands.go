package memex

import (
	"fmt"

	"github.com/systemshift/memex/internal/memex"
)

// Commands provides command functions for the CLI
type Commands struct {
	memex *Memex
}

// NewCommands creates a new Commands instance
func NewCommands() *Commands {
	return &Commands{}
}

// Close closes any open resources
func (c *Commands) Close() error {
	if c.memex != nil {
		return c.memex.Close()
	}
	return nil
}

// AutoConnect attempts to connect to a repository in the current directory
func (c *Commands) AutoConnect() error {
	if err := memex.OpenRepository(); err != nil {
		return fmt.Errorf("auto-connecting: %w", err)
	}
	return nil
}

// Init initializes a new repository
func (c *Commands) Init(name string) error {
	return memex.InitCommand(name)
}

// Connect connects to an existing repository
func (c *Commands) Connect(path string) error {
	return memex.ConnectCommand(path)
}

// Status shows repository status
func (c *Commands) Status() error {
	return memex.StatusCommand()
}

// Add adds a file to the repository
func (c *Commands) Add(path string) error {
	return memex.AddCommand(path)
}

// Delete removes a node
func (c *Commands) Delete(id string) error {
	return memex.DeleteCommand(id)
}

// Edit opens the editor for a new note
func (c *Commands) Edit() error {
	return memex.EditCommand()
}

// Link creates a link between nodes
func (c *Commands) Link(source, target, linkType, note string) error {
	args := []string{source, target, linkType}
	if note != "" {
		args = append(args, note)
	}
	return memex.LinkCommand(args...)
}

// Links shows links for a node
func (c *Commands) Links(id string) error {
	return memex.LinksCommand(id)
}

// Export exports the repository
func (c *Commands) Export(path string) error {
	return memex.ExportCommand(path)
}

// Import imports content into the repository
type ImportOptions struct {
	OnConflict string
	Merge      bool
	Prefix     string
}

// Import imports content from a file
func (c *Commands) Import(path string, opts ImportOptions) error {
	args := []string{path}
	if opts.OnConflict != "" {
		args = append(args, "--on-conflict", opts.OnConflict)
	}
	if opts.Merge {
		args = append(args, "--merge")
	}
	if opts.Prefix != "" {
		args = append(args, "--prefix", opts.Prefix)
	}
	return memex.ImportCommand(args...)
}
