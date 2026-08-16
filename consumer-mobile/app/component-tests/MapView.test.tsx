/* MapView: pure Views over lib/maps math — marker pin when coordinates are
 * given, location-unavailable placeholder when marker is null. */
import { render } from '@testing-library/react-native';

import { MapView } from '@/components/MapView';
import { t } from '@/i18n';
import { coordinateLabel, type Coordinate } from '@/lib/maps';

const CENTER: Coordinate = { lat: -6.792354, lon: 39.208328 };
const MARKER: Coordinate = { lat: -6.792354, lon: 39.208328 };

describe('MapView', () => {
  it('renders the surface with the accessibility label and value', async () => {
    const { getByLabelText } = await render(<MapView center={CENTER} marker={MARKER} />);
    const map = getByLabelText(t('map.a11y'));
    expect(map).toHaveAccessibilityValue({ text: coordinateLabel(CENTER) });
  });

  it('renders the coordinate caption', async () => {
    const { getByText } = await render(<MapView center={CENTER} marker={MARKER} />);
    expect(getByText(`${t('map.coordinates')}: ${coordinateLabel(CENTER)}`)).toBeTruthy();
  });

  it('renders the unavailable placeholder when the marker is null', async () => {
    const { getByText, queryByText } = await render(<MapView center={CENTER} marker={null} />);
    expect(getByText(t('map.unavailable'))).toBeTruthy();
    expect(queryByText(`${t('map.coordinates')}: ${coordinateLabel(CENTER)}`)).toBeTruthy();
  });

  it('omits the marker accessibility value when the marker is null', async () => {
    const { getByLabelText } = await render(<MapView center={CENTER} marker={null} />);
    const map = getByLabelText(t('map.a11y'));
    expect(map).not.toHaveAccessibilityValue({ text: coordinateLabel(CENTER) });
  });

  it('uses the provided a11y label instead of the default', async () => {
    const { getByLabelText } = await render(<MapView center={CENTER} marker={MARKER} label="Rider marker" />);
    expect(getByLabelText('Rider marker')).toBeTruthy();
  });
});
