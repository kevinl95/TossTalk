# BLE Protocol (Draft v0)

Service UUID:

- `9f8d0001-6b7b-4f26-b10f-3aa861aa0001`

Characteristics:

- Audio Notify: `9f8d0002-6b7b-4f26-b10f-3aa861aa0001`
- Battery Read/Notify: `9f8d0003-6b7b-4f26-b10f-3aa861aa0001`
- State Notify: `9f8d0004-6b7b-4f26-b10f-3aa861aa0001`
- Control Write: `9f8d0005-6b7b-4f26-b10f-3aa861aa0001`

## Audio frame (notify payload)

`[seq:u16][sampleRate:u16][sampleCount:u8][flags:u8][pcm16le...]`

- `flags bit0`: muted by motion
- `sampleRate`: initial target 8000
- `sampleCount`: 160 for 20 ms @ 8 kHz

## Battery payload

`[percent:u8][charging:u8]`

## State payload

`[gateState:u8][reserved:u8]`

`gateState` enum:

- `0` = `UnmutedLive`
- `1` = `AirborneSuppressed`
- `2` = `ImpactLockout`
- `3` = `Reacquire`