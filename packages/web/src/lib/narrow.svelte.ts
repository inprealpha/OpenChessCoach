// Whether the screen is phone-sized (up to 820 px wide), where the board frame stacks the panel
// under the board. Some parts move between the two: the Winning Chances graph sits under the board
// beside the panel, and folds into the panel on a phone.
const QUERY = '(max-width: 820px)';

class Narrow {
  on = $state(typeof matchMedia === 'function' && matchMedia(QUERY).matches);

  constructor() {
    if (typeof matchMedia !== 'function') return;
    matchMedia(QUERY).addEventListener('change', (e) => (this.on = e.matches));
  }
}

export const narrow = new Narrow();
