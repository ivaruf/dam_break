# A timber member snapping: a dry crack and a short spray of splinters.
use_random_seed 3
# Level trim: balances this cue against the rest of the set, which share one gain.
with_fx :level, amp: 2.0 do
  with_fx :reverb, room: 0.45, mix: 0.2 do
    sample :elec_wood, rate: 0.55, amp: 0.85
    sample :drum_snare_hard, rate: 1.3, amp: 0.3, lpf: 105
    sample :drum_tom_lo_soft, rate: 0.7, amp: 0.22
    with_fx :hpf, cutoff: 60 do
      use_synth :cnoise
      play 60, attack: 0.001, release: 0.06, amp: 0.7, cutoff: 120
      14.times do |i|
        sleep rrand(0.01, 0.035)
        play 60, attack: 0.001, release: rrand(0.008, 0.03), cutoff: rrand(85, 115), res: 0.5, amp: 0.45 * (1 - i / 16.0)
      end
    end
  end
end
