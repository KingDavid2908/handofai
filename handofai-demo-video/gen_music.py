import struct
import math
import wave
import random

SAMPLE_RATE = 44100
DURATION = 155  # ~2:35
NUM_CHANNELS = 2
SAMPLE_WIDTH = 2  # 16-bit

total_samples = SAMPLE_RATE * DURATION

def generate_pad(freq, amp, detune=0.0, phase=0.0):
    """Generate a simple pad oscillator"""
    f = freq + detune
    samples = []
    for i in range(total_samples):
        t = i / SAMPLE_RATE
        # Simple sine with slow amplitude modulation
        mod = 1.0 + 0.3 * math.sin(2 * math.pi * 0.1 * t + phase)
        val = amp * mod * math.sin(2 * math.pi * f * t)
        samples.append(val)
    return samples

def generate_bass(freq, amp):
    samples = []
    for i in range(total_samples):
        t = i / SAMPLE_RATE
        val = amp * math.sin(2 * math.pi * freq * t)
        # Add some saturation
        val = max(-1.0, min(1.0, val * 1.5))
        samples.append(val)
    return samples

def generate_arp(notes, amp, pattern_dur=2.0):
    samples = []
    for i in range(total_samples):
        t = i / SAMPLE_RATE
        pos = (t % pattern_dur) / pattern_dur
        note_idx = int(pos * len(notes)) % len(notes)
        freq = notes[note_idx]
        # Add fade between notes
        val = amp * math.sin(2 * math.pi * freq * t + 0.5 * math.sin(2 * math.pi * 0.5 * t))
        samples.append(val * 0.5)
    return samples

def mix(*tracks):
    result = [0.0] * total_samples
    for track in tracks:
        for i in range(len(track)):
            result[i] += track[i]
    # Normalize
    max_val = max(abs(max(result)), abs(min(result)), 0.01)
    gain = 0.8 / max_val
    result = [v * gain for v in result]
    return result

def write_wav(filename, samples):
    with wave.open(filename, 'w') as wav:
        wav.setnchannels(NUM_CHANNELS)
        wav.setsampwidth(SAMPLE_WIDTH)
        wav.setframerate(SAMPLE_RATE)
        data = b''
        for s in samples:
            # Convert float to 16-bit int
            s_int = int(max(-32768, min(32767, s * 32767)))
            data += struct.pack('<h', s_int)
        # Duplicate for stereo
        stereo = b''
        for i in range(0, len(data), 2):
            stereo += data[i:i+2] + data[i:i+2]
        wav.writeframes(stereo)

print("Generating ambient background music...")

# Create layered ambient pads
pad1 = generate_pad(110.0, 0.25, detune=0.5, phase=0.0)  # Deep A2 pad
pad2 = generate_pad(164.81, 0.15, detune=-0.3, phase=1.2)  # E3 
pad3 = generate_pad(220.0, 0.10, detune=0.7, phase=2.5)  # A3 shimmer

# Subtle bass pulse
bass = generate_bass(55.0, 0.20)

# Gentle arpeggiated pattern
arp_notes = [261.63, 329.63, 392.00, 523.25, 392.00, 329.63]  # C4 E4 G4 C5 G4 E4
arp = generate_arp(arp_notes, 0.08, pattern_dur=3.0)

# Mix everything
final = mix(pad1, pad2, pad3, bass, arp)

# Apply fade in/out
fade_frames = int(0.05 * SAMPLE_RATE)
for i in range(fade_frames):
    factor = i / fade_frames
    final[i] *= factor
    final[-(i+1)] *= factor

write_wav(r'C:\Users\USER\Downloads\handofai\handofaiwork\handofai-demo-video\public\bgm.wav', final)
print(f"Done! Generated {DURATION}s of ambient music -> public/bgm.wav")
print(f"Samples: {len(final)}, Max amplitude: {max(abs(v) for v in final):.3f}")
