import { Button, Dropdown, Header, Label, Separator } from '@heroui/react';
import { Icon } from './Icon';

const ROLE_LABEL = { admin: 'Admin', sre: 'SRE', viewer: 'Viewer' };
const THEMES = [['system', 'System', 'monitor'], ['light', 'Light', 'sun'], ['dark', 'Dark', 'moon']];

// The signed-in user's menu at the foot of the sidebar: their pages (Account, and Inject for writers, a dev tool),
// the theme (the current one is checked), and Log out. Keeps the sidebar to the pages people work in.
export function AccountMenu({ user, theme, onTheme, onOpen, onLogout, devTools }) {
  const onAction = (key) => {
    if (key === 'logout') onLogout();
    else if (key === 'account' || key === 'inject') onOpen(key);
  };
  return (
    <Dropdown>
      {/* The name is the visible text plus a hidden prefix ("Account menu: alice SRE"), so speech input can say what it sees */}
      <Button variant="ghost" className="user-block">
        <span className="sr-only">Account menu:</span>{' '}
        <span className="avatar" aria-hidden="true">{(user?.username || '?')[0].toUpperCase()}</span>
        <span className="user-meta">
          <span className="user-name">{user?.username}</span>{' '}
          <span className="user-role">{ROLE_LABEL[user?.role] ?? user?.role}</span>
        </span>
        <Icon name="chevron-up" size={14} />
      </Button>
      <Dropdown.Popover placement="top start" className="account-menu">
        <Dropdown.Menu onAction={onAction}>
          <Dropdown.Section>
            <Dropdown.Item id="account" textValue="Account"><Icon name="user" /><Label>Account</Label></Dropdown.Item>
            {devTools && <Dropdown.Item id="inject" textValue="Inject"><Icon name="zap" /><Label>Inject</Label></Dropdown.Item>}
          </Dropdown.Section>
          <Separator />
          <Dropdown.Section selectionMode="single" selectedKeys={new Set([theme])} disallowEmptySelection
            onSelectionChange={(keys) => { const [k] = keys; if (k) onTheme(k); }}>
            <Header>Theme</Header>
            {THEMES.map(([id, label, icon]) => (
              <Dropdown.Item key={id} id={id} textValue={label}><Icon name={icon} /><Label>{label}</Label><Dropdown.ItemIndicator /></Dropdown.Item>
            ))}
          </Dropdown.Section>
          <Separator />
          <Dropdown.Section>
            <Dropdown.Item id="logout" textValue="Log out"><Icon name="log-out" /><Label>Log out</Label></Dropdown.Item>
          </Dropdown.Section>
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}
