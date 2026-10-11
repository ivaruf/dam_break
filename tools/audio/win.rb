# The dam held: a warm rising plucked arpeggio over a held D major chord, a
# bell on top. About two and a half seconds; the result card is already up.
# Level trim: balances this cue against the rest of the set, which share one gain.
with_fx :level, amp: 2.6 do
  use_bpm 120
  with_fx :reverb, room: 0.75, mix: 0.4 do
    use_synth :hollow
    play chord(:d3, :major), attack: 0.1, sustain: 1.4, release: 1.8, amp: 0.55
    use_synth :pluck
    [:d4, :fs4, :a4, :d5].each do |n|
      play n, amp: 1.2
      sleep 0.5
    end
    play chord(:fs4, :minor), amp: 0.6
    use_synth :pretty_bell
    play :a5, amp: 0.22, release: 2
    use_synth :piano
    play chord(:d4, :major), amp: 0.12, hard: 0.3, vel: 0.45, sustain: 0.6, release: 1.4
    sleep 4
  end
end
