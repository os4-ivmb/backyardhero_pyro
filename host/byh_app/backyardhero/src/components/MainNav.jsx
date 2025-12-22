import React, { useEffect, useState } from 'react';
import InventoryManager from "./inventory/InventoryManager";
import useAppStore from '@/store/useAppStore';
import { FaExplosion, FaGear, FaList } from "react-icons/fa6";
import { FiTarget, FiEdit, FiRadio } from "react-icons/fi";
import { MdAssignment } from "react-icons/md";
import Image from 'next/image';
import ManualFiring from './manualFire/ManualFiring';
import Status from './homepanel/Status';
import StatusPanel from './homepanel/StatusPanel';
import SettingsPanel from './settings/SettingsPanel';
import ShowBuilder from './builder/ShowBuilder';
import ReceiverDisplay from './receivers/ReceiverDisplay';
import ShowLoadout from './receivers/ShowLoadout';

const MainNav = () => {
  const menuItems = [
    { label: "Main", icon: <FaExplosion/>, href: "/", key: "main" },
    { label: "Receivers", icon: <FiRadio/>, href: "/about", key: "receivers" },
    { label: "Show Editor", icon: <FiEdit/>, href: "/about", key: "editor" },
    { label: "Show Loadout", icon: <MdAssignment/>, href: "/loadout", key: "loadout" },
    { label: "Inventory", icon: <FaList/>, href: "/contact", key: "inventory" },
    { label: "Manual Fire", icon: <FiTarget/>, href: "/profile", key: "manual"  },
    { label: "Settings", icon: <FaGear/>, href: "/profile", key: "setting" },
  ];

  const { fetchInventory, fetchShows, fetchSystemConfig } = useAppStore();
  const [currTab, setCurrTab] = useState('main');
  


  useEffect(() => {
      fetchInventory();
    }, [fetchInventory]);

    useEffect(() => {
      fetchShows();
    }, [fetchShows]);

    useEffect(() => {
      fetchSystemConfig();
    }, [fetchSystemConfig]);

  return (
    <div>
        <nav className="bg-slate-900 text-white w-full border-b border-slate-700">
        <div className="flex items-center h-12">
            {/* Logo */}
            <div className="text-2xl font-bold px-3 flex items-center h-full">
            <Image src="/BYHLOGOv1.png" alt="anImage" width={80} height={40} style={{
              filter: 'invert(1)', 
              height: '40px',
              objectFit: 'contain',
              objectPosition: 'center',
              margin: '0',
              clipPath: 'inset(27% 10% 34% 10%)'
            }}/>
            </div>

            {/* Menu */}
            <ul className="flex flex-1 justify-around h-full">
            {menuItems.map((item, index) => (
                <li onClick={()=> setCurrTab(item.key)}
                key={index}
                className={`flex items-center space-x-1.5 px-3 py-1 h-full transition-all duration-200 flex-1 justify-center border-b-2 ${
                  currTab === item.key 
                    ? 'border-cyan-500 text-cyan-300 bg-slate-800 shadow-[0_0_8px_rgba(6,182,212,0.3)]' 
                    : 'border-transparent text-slate-400 hover:text-slate-300 hover:border-slate-600'
                }`}
                >
                <span className="text-sm">{item.icon}</span>
                <span className="text-sm font-medium">
                    {item.label}
                </span>
                </li>
            ))}
            </ul>
        </div>
        </nav>
        <div className="mb-12">
            <div className={`${currTab==='main' ? '' : 'hidden'}`}><StatusPanel setCurrentTab={setCurrTab}/></div>
            <div className={`${currTab==='inventory' ? '' : 'hidden'}`}><InventoryManager/></div>
            <div className={`${currTab==='editor' ? '' : 'hidden'}`}><ShowBuilder/></div>
            <div className={`${currTab==='receivers' ? '' : 'hidden'}`}><ReceiverDisplay setCurrentTab={setCurrTab}/></div>
            <div className={`${currTab==='loadout' ? '' : 'hidden'}`}><ShowLoadout setCurrentTab={setCurrTab}/></div>
            {currTab==='manual' ? (<ManualFiring/>) : ""}
            {currTab==='setting' ? (<SettingsPanel/>) : ""}
        </div>
        <div className="absolute bottom-0 left-0 w-full border-t border-slate-700 px-3 bg-slate-900 bg-opacity-95 backdrop-blur-sm">
            <Status/>
        </div>
    </div>
  );
};
export default MainNav;