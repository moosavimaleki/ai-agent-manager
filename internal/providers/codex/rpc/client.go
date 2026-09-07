package rpc

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
)

type Transport interface {
	Send(message []byte) error
}

type Client struct {
	transport Transport
	nextID    atomic.Int64

	mu       sync.Mutex
	pending  map[string]chan responseEnvelope
	stderr   strings.Builder
	closeErr error

	notifications chan Notification
}

type Notification struct {
	ID     string          `json:"id,omitempty"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params,omitempty"`
}

type requestEnvelope struct {
	ID     string `json:"id"`
	Method string `json:"method"`
	Params any    `json:"params,omitempty"`
}

type responseEnvelope struct {
	ID     string          `json:"id"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  *ResponseError  `json:"error,omitempty"`
}

type ResponseError struct {
	Code    int    `json:"code,omitempty"`
	Message string `json:"message,omitempty"`
}

func (e *ResponseError) Error() string {
	if e == nil {
		return ""
	}
	if e.Code != 0 {
		return fmt.Sprintf("json-rpc error %d: %s", e.Code, e.Message)
	}
	return e.Message
}

func NewClient(transport Transport) *Client {
	return &Client{
		transport:     transport,
		pending:       map[string]chan responseEnvelope{},
		notifications: make(chan Notification, 128),
	}
}

func (c *Client) Call(ctx context.Context, method string, params any, result any) error {
	id := strconv.FormatInt(c.nextID.Add(1), 10)
	responseCh := make(chan responseEnvelope, 1)

	c.mu.Lock()
	if c.closeErr != nil {
		err := c.closeErr
		c.mu.Unlock()
		return err
	}
	c.pending[id] = responseCh
	c.mu.Unlock()

	payload, err := json.Marshal(requestEnvelope{
		ID:     id,
		Method: method,
		Params: params,
	})
	if err != nil {
		c.deletePending(id)
		return err
	}
	if err := c.transport.Send(payload); err != nil {
		c.deletePending(id)
		return err
	}

	select {
	case <-ctx.Done():
		c.deletePending(id)
		return ctx.Err()
	case response := <-responseCh:
		if response.Error != nil {
			return response.Error
		}
		if result == nil || len(response.Result) == 0 {
			return nil
		}
		return json.Unmarshal(response.Result, result)
	}
}

// Close fails every JSON-RPC call that is waiting for a response. The stdio
// transport has no response once app-server exits; leaving those calls pending
// would strand a chat in "starting" forever.
func (c *Client) Close(err error) {
	if err == nil {
		err = errors.New("codex app-server stopped")
	}
	c.mu.Lock()
	if c.closeErr != nil {
		c.mu.Unlock()
		return
	}
	c.closeErr = err
	pending := c.pending
	c.pending = map[string]chan responseEnvelope{}
	c.mu.Unlock()

	responseErr := &ResponseError{Message: err.Error()}
	for _, responseCh := range pending {
		responseCh <- responseEnvelope{Error: responseErr}
	}
}

func (c *Client) HandleMessage(data []byte) error {
	var header struct {
		ID     any             `json:"id,omitempty"`
		Method string          `json:"method,omitempty"`
		Params json.RawMessage `json:"params,omitempty"`
	}
	if err := json.Unmarshal(data, &header); err != nil {
		return err
	}

	id := normalizeID(header.ID)
	if header.Method != "" {
		c.notifications <- Notification{ID: id, Method: header.Method, Params: header.Params}
		return nil
	}
	if id == "" {
		return errors.New("json-rpc response missing id")
	}

	var response responseEnvelope
	if err := json.Unmarshal(data, &response); err != nil {
		return err
	}
	response.ID = id

	c.mu.Lock()
	responseCh := c.pending[id]
	if responseCh != nil {
		delete(c.pending, id)
	}
	c.mu.Unlock()

	if responseCh == nil {
		return nil
	}
	responseCh <- response
	return nil
}

func (c *Client) Notifications() <-chan Notification {
	return c.notifications
}

func (c *Client) RecordStderr(line string) {
	c.mu.Lock()
	defer c.mu.Unlock()

	c.stderr.WriteString(line)
	if !strings.HasSuffix(line, "\n") {
		c.stderr.WriteByte('\n')
	}
}

func (c *Client) Stderr() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.stderr.String()
}

func (c *Client) deletePending(id string) {
	c.mu.Lock()
	delete(c.pending, id)
	c.mu.Unlock()
}

func normalizeID(value any) string {
	switch typed := value.(type) {
	case string:
		return typed
	case float64:
		return strconv.FormatInt(int64(typed), 10)
	default:
		return ""
	}
}
