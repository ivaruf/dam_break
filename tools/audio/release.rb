# The flood released: a heavy sluice gate clunks free, the ground thumps, and
# the water surges in under it — about two and a half seconds, rising then
# easing, so it hands over to the flood theme instead of fighting it.
use_random_seed 5
# Level trim: balances this cue against the rest of the set, which share one gain.
with_fx :level, amp: 1.6 do
  with_fx :reverb, room: 0.6, mix: 0.3 do
    sample :drum_heavy_kick, rate: 0.55, amp: 0.8
    sample :elec_wood, rate: 0.4, amp: 0.5
    use_synth :sine
    s = play 26, note_slide: 1.2, attack: 0.05, sustain: 0.6, release: 1.0, amp: 0.5
    control s, note: 33
    with_fx :lpf, cutoff: 62, cutoff_slide: 1.1 do |f|
      control f, cutoff: 102
      use_synth :bnoise
      play 60, attack: 0.5, sustain: 0.7, release: 1.2, amp: 0.85
      sleep 1.1
      control f, cutoff_slide: 1.2, cutoff: 80
      sleep 1.3
    end
  end
end
