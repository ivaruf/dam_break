# A concrete beam set down: a heavy soft thud and a little grit settling.
use_random_seed 4
# Level trim: balances this cue against the rest of the set, which share one gain.
with_fx :level, amp: 2.2 do
  sample :drum_heavy_kick, rate: 0.7, amp: 0.75, lpf: 80
  sample :drum_tom_lo_hard, rate: 0.55, amp: 0.35, lpf: 70
  with_fx :lpf, cutoff: 95 do
    use_synth :cnoise
    10.times do |i|
      play 60, attack: 0.001, release: rrand(0.01, 0.03), amp: 0.3 * (1 - i / 12.0) * rrand(0.4, 1.0)
      sleep rrand(0.012, 0.03)
    end
  end
end
