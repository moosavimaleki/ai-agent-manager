package eventstore

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"abolqasem/internal/workspace/events"
	"abolqasem/internal/workspace/readmodels"
)

var ErrInvalidStream = errors.New("invalid event stream")

const (
	SnapshotFileName       = "snapshot.json"
	CompactionThreshold    = 2 * 1024 * 1024
	autoCompactionCooldown = 15 * time.Minute
	snapshotFileMode       = 0o644
	eventLogFileMode       = 0o644
	eventLogScannerBuffer  = 64 * 1024 * 1024
	reverseReadChunkSize   = 4 * 1024 * 1024
)

type SnapshotFile struct {
	V              int                        `json:"v"`
	GeneratedAt    int64                      `json:"generatedAt"`
	Projects       []readmodels.ProjectRecord `json:"projects"`
	Chats          []readmodels.ChatRecord    `json:"chats"`
	QueuedMessages []QueuedMessageSet         `json:"queuedMessages,omitempty"`
}

type QueuedMessageSet struct {
	ChatID  string                         `json:"chatId"`
	Entries []readmodels.QueuedChatMessage `json:"entries"`
}

type Store struct {
	dir string
	mu  *sync.Mutex
}

var storeLocks sync.Map

var autoCompaction = struct {
	sync.Mutex
	running map[string]bool
	lastRun map[string]time.Time
}{
	running: map[string]bool{},
	lastRun: map[string]time.Time{},
}

func New(dir string) *Store {
	dir = filepath.Clean(dir)
	lock, _ := storeLocks.LoadOrStore(dir, &sync.Mutex{})
	return &Store{dir: dir, mu: lock.(*sync.Mutex)}
}

func (s *Store) Dir() string {
	return s.dir
}

func (s *Store) Append(stream string, event events.Event) error {
	if err := validateStream(stream); err != nil {
		return err
	}
	if event.V == 0 {
		event.V = events.Version
	}
	if event.Type == "" {
		return errors.New("event type is required")
	}
	if event.Timestamp == 0 {
		return errors.New("event timestamp is required")
	}

	data, err := json.Marshal(event)
	if err != nil {
		return err
	}
	data = append(data, '\n')

	s.mu.Lock()
	if err := os.MkdirAll(s.dir, 0o755); err != nil {
		s.mu.Unlock()
		return err
	}
	file, err := os.OpenFile(s.streamPath(stream), os.O_CREATE|os.O_WRONLY|os.O_APPEND, eventLogFileMode)
	if err != nil {
		s.mu.Unlock()
		return err
	}
	_, writeErr := file.Write(data)
	closeErr := file.Close()
	s.mu.Unlock()
	if writeErr != nil {
		return writeErr
	}
	if closeErr != nil {
		return closeErr
	}
	s.maybeCompactAsync()
	return nil
}

func (s *Store) Replay(stream string) ([]events.Event, error) {
	if err := validateStream(stream); err != nil {
		return nil, err
	}

	file, err := os.Open(s.streamPath(stream))
	if err != nil {
		if os.IsNotExist(err) {
			return []events.Event{}, nil
		}
		return nil, err
	}
	defer file.Close()

	var result []events.Event
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 0, 64*1024), eventLogScannerBuffer)
	lineNumber := 0
	for scanner.Scan() {
		lineNumber++
		line := trimEventLogLine(scanner.Bytes())
		if len(line) == 0 {
			continue
		}
		var event events.Event
		if err := json.Unmarshal(line, &event); err != nil {
			return nil, fmt.Errorf("%s:%d: %w", s.streamPath(stream), lineNumber, err)
		}
		result = append(result, event)
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	return result, nil
}

func (s *Store) LoadState() (readmodels.StoreState, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	return s.loadStateForStreamsLocked(events.Streams())
}

func (s *Store) LoadStateLight() (readmodels.StoreState, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	return s.loadStateForStreamsLocked([]string{
		events.StreamProjects,
		events.StreamChats,
		events.StreamQueuedMessages,
		events.StreamTurns,
	})
}

func (s *Store) ReplayMessagesForChat(chatID string) ([]events.Event, error) {
	chatID = strings.TrimSpace(chatID)
	if chatID == "" {
		return []events.Event{}, nil
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	return s.replayMessagesForChatLocked(chatID)
}

func (s *Store) ReplayTranscriptEntriesForChat(chatID string, tailLimit int) ([]readmodels.TranscriptEntry, error) {
	chatID = strings.TrimSpace(chatID)
	if chatID == "" {
		return []readmodels.TranscriptEntry{}, nil
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	return s.replayTranscriptEntriesForChatLocked(chatID, tailLimit)
}

func (s *Store) LastMessageEventForChat(chatID string) (string, int64, error) {
	chatID = strings.TrimSpace(chatID)
	if chatID == "" {
		return "", 0, nil
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	return s.lastMessageEventForChatLocked(chatID)
}

func (s *Store) Compact(state readmodels.StoreState) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.compactLocked(state)
}

func (s *Store) compactLocked(state readmodels.StoreState) error {
	if err := os.MkdirAll(s.dir, 0o755); err != nil {
		return err
	}

	snapshot := SnapshotFile{
		V:              events.Version,
		GeneratedAt:    time.Now().UnixMilli(),
		Projects:       activeProjects(state),
		Chats:          activeChats(state),
		QueuedMessages: queuedMessages(state),
	}
	payload, err := json.MarshalIndent(snapshot, "", "  ")
	if err != nil {
		return err
	}
	payload = append(payload, '\n')

	tmpPath := s.snapshotPath() + ".tmp"
	if err := os.WriteFile(tmpPath, payload, snapshotFileMode); err != nil {
		return err
	}
	if err := os.Rename(tmpPath, s.snapshotPath()); err != nil {
		return err
	}

	compactedMessages, err := s.compactedMessageEventsLocked(state, snapshot.GeneratedAt)
	if err != nil {
		return err
	}
	if _, _, err := s.archiveStreamLocked(events.StreamMessages, snapshot.GeneratedAt); err != nil {
		return err
	}
	for _, stream := range events.Streams() {
		if err := os.WriteFile(s.streamPath(stream), nil, eventLogFileMode); err != nil {
			return err
		}
	}
	if len(compactedMessages) > 0 {
		if err := s.writeEventsLocked(events.StreamMessages, compactedMessages); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) archiveStreamLocked(stream string, timestamp int64) (string, bool, error) {
	source := s.streamPath(stream)
	info, err := os.Stat(source)
	if err != nil {
		if os.IsNotExist(err) {
			return "", false, nil
		}
		return "", false, err
	}
	if info.Size() == 0 {
		return "", false, nil
	}
	archivePath := s.archiveStreamPathLocked(stream, timestamp)
	if err := os.Rename(source, archivePath); err != nil {
		return "", false, err
	}
	return archivePath, true, nil
}

func (s *Store) archiveStreamPathLocked(stream string, timestamp int64) string {
	when := time.UnixMilli(timestamp).UTC().Format("20060102T150405.000Z")
	base := filepath.Join(s.dir, stream+".jsonl.archived-"+when)
	path := base
	for index := 1; ; index++ {
		if _, err := os.Stat(path); os.IsNotExist(err) {
			return path
		}
		path = fmt.Sprintf("%s-%d", base, index)
	}
}

func (s *Store) ShouldCompact() (bool, error) {
	var total int64
	for _, stream := range events.Streams() {
		info, err := os.Stat(s.streamPath(stream))
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return false, err
		}
		total += info.Size()
	}
	return total >= CompactionThreshold, nil
}

func (s *Store) maybeCompactAsync() {
	shouldCompact, err := s.ShouldCompact()
	if err != nil || !shouldCompact {
		return
	}
	key := filepath.Clean(s.dir)
	now := time.Now()
	autoCompaction.Lock()
	if autoCompaction.running[key] || now.Sub(autoCompaction.lastRun[key]) < autoCompactionCooldown {
		autoCompaction.Unlock()
		return
	}
	autoCompaction.running[key] = true
	autoCompaction.Unlock()

	go func() {
		defer func() {
			autoCompaction.Lock()
			autoCompaction.running[key] = false
			autoCompaction.lastRun[key] = time.Now()
			autoCompaction.Unlock()
		}()
		s.mu.Lock()
		defer s.mu.Unlock()
		state, err := s.loadStateForStreamsLocked(events.Streams())
		if err != nil {
			return
		}
		_ = s.compactLocked(state)
	}()
}

func (s *Store) streamPath(stream string) string {
	return filepath.Join(s.dir, stream+".jsonl")
}

func (s *Store) snapshotPath() string {
	return filepath.Join(s.dir, SnapshotFileName)
}

func (s *Store) compactedMessageEventsLocked(state readmodels.StoreState, fallbackTimestamp int64) ([]events.Event, error) {
	chatIDs := make([]string, 0, len(state.ChatsByID))
	for chatID, chat := range state.ChatsByID {
		if chat.DeletedAt != 0 || !chat.HasMessages || strings.TrimSpace(chat.TmuxSession) != "" {
			continue
		}
		chatIDs = append(chatIDs, chatID)
	}
	sort.Strings(chatIDs)

	out := make([]events.Event, 0, len(chatIDs))
	for _, chatID := range chatIDs {
		chat := state.ChatsByID[chatID]
		messages, err := s.replayTranscriptEntriesForChatLocked(chatID, 0)
		if err != nil {
			return nil, err
		}
		if len(messages) == 0 {
			continue
		}
		timestamp := chat.LastMessageAt
		if timestamp <= 0 {
			timestamp = chat.UpdatedAt
		}
		if timestamp <= 0 {
			timestamp = fallbackTimestamp
		}
		event, err := events.NewAt(events.TypeChatRestoredToCheckpoint, timestamp, map[string]any{
			"chatId":       chatID,
			"checkpointId": "eventstore-compaction",
			"messages":     messages,
		})
		if err != nil {
			return nil, err
		}
		out = append(out, event)
	}
	return out, nil
}

func (s *Store) writeEventsLocked(stream string, eventsList []events.Event) error {
	if len(eventsList) == 0 {
		return nil
	}
	file, err := os.OpenFile(s.streamPath(stream), os.O_CREATE|os.O_WRONLY|os.O_TRUNC, eventLogFileMode)
	if err != nil {
		return err
	}
	defer file.Close()
	encoder := json.NewEncoder(file)
	for _, event := range eventsList {
		if event.V == 0 {
			event.V = events.Version
		}
		if err := encoder.Encode(event); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) loadSnapshotLocked() (readmodels.StoreState, error) {
	state := readmodels.EmptyState()
	data, err := os.ReadFile(s.snapshotPath())
	if err != nil {
		if os.IsNotExist(err) {
			return state, nil
		}
		return readmodels.StoreState{}, err
	}
	if strings.TrimSpace(string(data)) == "" {
		return state, nil
	}

	var snapshot SnapshotFile
	if err := json.Unmarshal(data, &snapshot); err != nil {
		return readmodels.StoreState{}, err
	}
	if snapshot.V != events.Version {
		return readmodels.StoreState{}, fmt.Errorf("unsupported snapshot version: %d", snapshot.V)
	}

	for _, project := range snapshot.Projects {
		state.ProjectsByID[project.ID] = project
		if project.LocalPath != "" && project.DeletedAt == 0 {
			state.ProjectIDsByPath[project.LocalPath] = project.ID
		}
	}
	for _, chat := range snapshot.Chats {
		state.ChatsByID[chat.ID] = chat
	}
	for _, queuedSet := range snapshot.QueuedMessages {
		state.QueuedMessagesByChatID[queuedSet.ChatID] = append([]readmodels.QueuedChatMessage(nil), queuedSet.Entries...)
	}
	return state, nil
}

func (s *Store) loadStateForStreamsLocked(streams []string) (readmodels.StoreState, error) {
	state, err := s.loadSnapshotLocked()
	if err != nil {
		return readmodels.StoreState{}, err
	}
	replayed, err := s.replayOrderedLocked(streams)
	if err != nil {
		return readmodels.StoreState{}, err
	}
	for _, event := range replayed {
		state = readmodels.Apply(state, event)
	}
	return state, nil
}

func (s *Store) replayOrderedLocked(streams []string) ([]events.Event, error) {
	type replayEvent struct {
		event       events.Event
		sourceIndex int
		lineIndex   int
	}

	var replayed []replayEvent
	for sourceIndex, stream := range streams {
		streamEvents, err := s.replayStreamLocked(stream)
		if err != nil {
			return nil, err
		}
		for lineIndex, event := range streamEvents {
			replayed = append(replayed, replayEvent{
				event:       event,
				sourceIndex: sourceIndex,
				lineIndex:   lineIndex,
			})
		}
	}

	sort.SliceStable(replayed, func(i, j int) bool {
		left := replayed[i]
		right := replayed[j]
		if left.event.Timestamp != right.event.Timestamp {
			return left.event.Timestamp < right.event.Timestamp
		}
		if eventPriority(left.event.Type) != eventPriority(right.event.Type) {
			return eventPriority(left.event.Type) < eventPriority(right.event.Type)
		}
		if left.sourceIndex != right.sourceIndex {
			return left.sourceIndex < right.sourceIndex
		}
		return left.lineIndex < right.lineIndex
	})

	result := make([]events.Event, 0, len(replayed))
	for _, entry := range replayed {
		result = append(result, entry.event)
	}
	return result, nil
}

func (s *Store) replayMessagesForChatLocked(chatID string) ([]events.Event, error) {
	rawEvents, err := s.replayRawMessageLinesForChatLocked(chatID)
	if err != nil {
		return nil, err
	}

	filtered := make([]events.Event, 0, len(rawEvents))
	for _, raw := range rawEvents {
		var event events.Event
		if err := json.Unmarshal(raw.data, &event); err != nil {
			return nil, fmt.Errorf("%s:%d: %w", s.streamPath(events.StreamMessages), raw.lineNumber, err)
		}
		if eventChatID(event) != chatID {
			continue
		}
		filtered = append(filtered, event)
	}
	return filtered, nil
}

func (s *Store) replayTranscriptEntriesForChatLocked(chatID string, tailLimit int) ([]readmodels.TranscriptEntry, error) {
	if tailLimit > 0 {
		return s.replayTranscriptEntriesTailForChatLocked(chatID, tailLimit)
	}

	rawEvents, err := s.replayRawMessageLinesForChatLocked(chatID)
	if err != nil {
		return nil, err
	}

	entries := make([]readmodels.TranscriptEntry, 0)
	for _, rawLine := range rawEvents {
		var rawEvent struct {
			Type     string            `json:"type"`
			ChatID   string            `json:"chatId"`
			Entry    json.RawMessage   `json:"entry"`
			Messages []json.RawMessage `json:"messages"`
		}
		if err := json.Unmarshal(rawLine.data, &rawEvent); err != nil {
			return nil, fmt.Errorf("%s:%d: %w", s.streamPath(events.StreamMessages), rawLine.lineNumber, err)
		}
		if strings.TrimSpace(rawEvent.ChatID) != chatID {
			continue
		}

		switch rawEvent.Type {
		case events.TypeMessageAppended:
			if len(rawEvent.Entry) == 0 {
				continue
			}
			var entry readmodels.TranscriptEntry
			if err := json.Unmarshal(rawEvent.Entry, &entry); err != nil {
				return nil, fmt.Errorf("%s:%d entry: %w", s.streamPath(events.StreamMessages), rawLine.lineNumber, err)
			}
			entries = append(entries, entry)
		case events.TypeChatRestoredToCheckpoint:
			messages := rawEvent.Messages
			if tailLimit > 0 && len(messages) > tailLimit {
				messages = messages[len(messages)-tailLimit:]
			}
			entries = make([]readmodels.TranscriptEntry, 0, len(messages))
			for index, rawMessage := range messages {
				var entry readmodels.TranscriptEntry
				if err := json.Unmarshal(rawMessage, &entry); err != nil {
					return nil, fmt.Errorf("%s:%d messages[%d]: %w", s.streamPath(events.StreamMessages), rawLine.lineNumber, index, err)
				}
				entries = append(entries, entry)
			}
		}

		if tailLimit > 0 && len(entries) > tailLimit {
			entries = entries[len(entries)-tailLimit:]
		}
	}
	return entries, nil
}

func (s *Store) lastMessageEventForChatLocked(chatID string) (string, int64, error) {
	chatNeedle := []byte(`"chatId":` + strconv.Quote(chatID))
	var eventType string
	var eventTimestamp int64

	err := s.scanMessageLinesReverseLocked(func(line []byte) (bool, error) {
		if !bytes.Contains(line, chatNeedle) {
			return false, nil
		}

		var rawEvent struct {
			Type      string `json:"type"`
			Timestamp int64  `json:"timestamp"`
			ChatID    string `json:"chatId"`
		}
		if err := json.Unmarshal(line, &rawEvent); err != nil {
			return false, err
		}
		if strings.TrimSpace(rawEvent.ChatID) != chatID {
			return false, nil
		}
		eventType = rawEvent.Type
		eventTimestamp = rawEvent.Timestamp
		return true, nil
	})
	if err != nil {
		return "", 0, fmt.Errorf("%s reverse: %w", s.streamPath(events.StreamMessages), err)
	}
	return eventType, eventTimestamp, nil
}

func (s *Store) replayTranscriptEntriesTailForChatLocked(chatID string, tailLimit int) ([]readmodels.TranscriptEntry, error) {
	chatNeedle := []byte(`"chatId":` + strconv.Quote(chatID))
	newestFirst := make([]readmodels.TranscriptEntry, 0, tailLimit)

	err := s.scanMessageLinesReverseLocked(func(line []byte) (bool, error) {
		if !bytes.Contains(line, chatNeedle) {
			return false, nil
		}

		var rawEvent struct {
			Type     string            `json:"type"`
			ChatID   string            `json:"chatId"`
			Entry    json.RawMessage   `json:"entry"`
			Messages []json.RawMessage `json:"messages"`
		}
		if err := json.Unmarshal(line, &rawEvent); err != nil {
			return false, err
		}
		if strings.TrimSpace(rawEvent.ChatID) != chatID {
			return false, nil
		}

		switch rawEvent.Type {
		case events.TypeMessageAppended:
			if len(rawEvent.Entry) == 0 {
				return false, nil
			}
			var entry readmodels.TranscriptEntry
			if err := json.Unmarshal(rawEvent.Entry, &entry); err != nil {
				return false, fmt.Errorf("entry: %w", err)
			}
			newestFirst = append(newestFirst, entry)
			return len(newestFirst) >= tailLimit, nil
		case events.TypeChatRestoredToCheckpoint:
			needed := tailLimit - len(newestFirst)
			if needed > 0 {
				messages := rawEvent.Messages
				if len(messages) > needed {
					messages = messages[len(messages)-needed:]
				}
				for index := len(messages) - 1; index >= 0; index-- {
					var entry readmodels.TranscriptEntry
					if err := json.Unmarshal(messages[index], &entry); err != nil {
						return false, fmt.Errorf("messages[%d]: %w", index, err)
					}
					newestFirst = append(newestFirst, entry)
				}
			}
			return true, nil
		default:
			return false, nil
		}
	})
	if err != nil {
		return nil, fmt.Errorf("%s reverse: %w", s.streamPath(events.StreamMessages), err)
	}

	entries := make([]readmodels.TranscriptEntry, len(newestFirst))
	for index := range newestFirst {
		entries[len(newestFirst)-1-index] = newestFirst[index]
	}
	return entries, nil
}

func (s *Store) scanMessageLinesReverseLocked(visit func(line []byte) (bool, error)) error {
	file, err := os.Open(s.streamPath(events.StreamMessages))
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	defer file.Close()

	info, err := file.Stat()
	if err != nil {
		return err
	}

	offset := info.Size()
	pending := []byte(nil)
	trimTrailingNewline := true
	for offset > 0 {
		readSize := int64(reverseReadChunkSize)
		if readSize > offset {
			readSize = offset
		}
		offset -= readSize

		chunk := make([]byte, int(readSize))
		if _, err := file.ReadAt(chunk, offset); err != nil {
			return err
		}

		data := append(chunk, pending...)
		end := len(data)
		if trimTrailingNewline {
			trimTrailingNewline = false
			for end > 0 && (data[end-1] == '\n' || data[end-1] == '\r') {
				end--
			}
		}

		for end > 0 {
			newline := bytes.LastIndexByte(data[:end], '\n')
			if newline < 0 {
				break
			}
			line := bytes.TrimSpace(data[newline+1 : end])
			if len(line) > 0 {
				stop, err := visit(line)
				if err != nil {
					return err
				}
				if stop {
					return nil
				}
			}
			end = newline
		}

		pending = append(pending[:0], data[:end]...)
	}

	line := bytes.TrimSpace(pending)
	if len(line) == 0 {
		return nil
	}
	_, err = visit(line)
	return err
}

type rawMessageLine struct {
	data       []byte
	lineNumber int
}

func (s *Store) replayRawMessageLinesForChatLocked(chatID string) ([]rawMessageLine, error) {
	file, err := os.Open(s.streamPath(events.StreamMessages))
	if err != nil {
		if os.IsNotExist(err) {
			return []rawMessageLine{}, nil
		}
		return nil, err
	}
	defer file.Close()

	chatNeedle := []byte(`"chatId":` + strconv.Quote(chatID))
	restoreNeedle := []byte(`"type":"` + events.TypeChatRestoredToCheckpoint + `"`)
	rawEvents := make([]rawMessageLine, 0)

	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 0, 64*1024), eventLogScannerBuffer)
	lineNumber := 0
	for scanner.Scan() {
		lineNumber++
		line := bytes.TrimSpace(scanner.Bytes())
		if len(line) == 0 || !bytes.Contains(line, chatNeedle) {
			continue
		}
		lineCopy := append([]byte(nil), line...)
		if bytes.Contains(lineCopy, restoreNeedle) {
			rawEvents = rawEvents[:0]
		}
		rawEvents = append(rawEvents, rawMessageLine{
			data:       lineCopy,
			lineNumber: lineNumber,
		})
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	return rawEvents, nil
}

func (s *Store) replayStreamLocked(stream string) ([]events.Event, error) {
	file, err := os.Open(s.streamPath(stream))
	if err != nil {
		if os.IsNotExist(err) {
			return []events.Event{}, nil
		}
		return nil, err
	}
	defer file.Close()

	var result []events.Event
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 0, 64*1024), eventLogScannerBuffer)
	lineNumber := 0
	for scanner.Scan() {
		lineNumber++
		line := trimEventLogLine(scanner.Bytes())
		if len(line) == 0 {
			continue
		}
		var event events.Event
		if err := json.Unmarshal(line, &event); err != nil {
			return nil, fmt.Errorf("%s:%d: %w", s.streamPath(stream), lineNumber, err)
		}
		result = append(result, event)
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	return result, nil
}

func trimEventLogLine(line []byte) []byte {
	return bytes.TrimSpace(bytes.Trim(line, "\x00"))
}

func validateStream(stream string) error {
	switch stream {
	case events.StreamProjects,
		events.StreamChats,
		events.StreamMessages,
		events.StreamQueuedMessages,
		events.StreamTurns:
		return nil
	default:
		return fmt.Errorf("%w: %s", ErrInvalidStream, stream)
	}
}

func activeProjects(state readmodels.StoreState) []readmodels.ProjectRecord {
	projects := make([]readmodels.ProjectRecord, 0, len(state.ProjectsByID))
	for _, project := range state.ProjectsByID {
		if project.DeletedAt != 0 {
			continue
		}
		projects = append(projects, project)
	}
	sort.Slice(projects, func(i, j int) bool {
		return projects[i].UpdatedAt > projects[j].UpdatedAt
	})
	return projects
}

func activeChats(state readmodels.StoreState) []readmodels.ChatRecord {
	chats := make([]readmodels.ChatRecord, 0, len(state.ChatsByID))
	for _, chat := range state.ChatsByID {
		if chat.DeletedAt != 0 {
			continue
		}
		chats = append(chats, chat)
	}
	sort.Slice(chats, func(i, j int) bool {
		return chats[i].UpdatedAt > chats[j].UpdatedAt
	})
	return chats
}

func queuedMessages(state readmodels.StoreState) []QueuedMessageSet {
	sets := make([]QueuedMessageSet, 0, len(state.QueuedMessagesByChatID))
	for chatID, entries := range state.QueuedMessagesByChatID {
		if len(entries) == 0 {
			continue
		}
		sets = append(sets, QueuedMessageSet{
			ChatID:  chatID,
			Entries: append([]readmodels.QueuedChatMessage(nil), entries...),
		})
	}
	sort.Slice(sets, func(i, j int) bool {
		return sets[i].ChatID < sets[j].ChatID
	})
	return sets
}

func eventPriority(eventType string) int {
	switch eventType {
	case events.TypeProjectOpened, events.TypeProjectSidebarRenamed, events.TypeProjectRemoved:
		return 0
	case events.TypeChatCreated:
		return 1
	case events.TypeChatRenamed, events.TypeChatProviderSet, events.TypeChatPlanModeSet, events.TypeChatPinned, events.TypeChatPinnedReordered:
		return 2
	case events.TypeMessageAppended:
		return 3
	case events.TypeQueuedMessageEnqueued, events.TypeQueuedMessageUpdated, events.TypeQueuedMessageRemoved:
		return 4
	case events.TypeTurnStarted:
		return 5
	case events.TypeSessionTokenSet, events.TypePendingForkSessionTokenSet:
		return 6
	case events.TypeTurnCancelled:
		return 7
	case events.TypeTurnFinished, events.TypeTurnFailed:
		return 8
	case events.TypeChatReadStateSet:
		return 9
	case events.TypeChatDeleted, events.TypeChatArchived, events.TypeChatUnarchived:
		return 10
	default:
		return 100
	}
}

func eventChatID(event events.Event) string {
	value, _ := event.Fields["chatId"].(string)
	return strings.TrimSpace(value)
}
