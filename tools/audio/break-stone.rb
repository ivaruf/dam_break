# A concrete member cracking apart: a heavy crack and rubble tumbling away.
use_random_seed 11
# Level trim: balances this cue against the rest of the set, which share one gain.
with_fx :level, amp: 2.5 do
  with_fx :reverb, room: 0.5, mix: 0.25 do
    sample :drum_heavy_kick, rate: 0.6, amp: 0.75
    sample :drum_snare_hard, rate: 0.6, amp: 0.28, lpf: 85
    with_fx :lpf, cutoff: 102, cutoff_slide: 0.9 do |f|
      control f, cutoff: 70
      use_synth :cnoise
      24.times do |i|
        play 60, attack: 0.001, release: rrand(0.01, 0.05), cutoff: rrand(70, 105), amp: rrand(0.2, 0.55) * (1 - i / 28.0)
        sleep rrand(0.015, 0.05)
      end
    end
  end
end
