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
        <nav className="bg-gray-800 text-white p-0 w-full border-b border-gray-600">
        <div className="flex items-center">
            {/* Logo */}
            <div className="text-2xl font-bold px-4">
            <Image src="/BYHLOGOv1.png" alt="anImage" width={100} height={60} style={{
              filter: 'invert(1)', 
              height: '70px',
              
              objectFit: 'contain',
              objectPosition: 'center',
        
              margin: '-22px',
              marginLeft: '-6px',
              clipPath: 'inset(27% 10% 34% 10%)'
            }}/>
            </div>

            {/* Menu */}
            <ul className="flex flex-1 justify-around">
            {menuItems.map((item, index) => (
                <li onClick={()=> setCurrTab(item.key)}
                key={index}
                className={`flex items-center space-x-2 px-4 py-2 hover:bg-gray-700 transition flex-1 justify-center ${currTab === item.key ? 'bg-gray-600':''}`}
                >
                <span>{item.icon}</span>
                <span className="text-lg">
                    {item.label}
                </span>
                </li>
            ))}
            </ul>
        </div>
        </nav>
        <div className="mb-14">
            <div className={`${currTab==='main' ? '' : 'hidden'}`}><StatusPanel setCurrentTab={setCurrTab}/></div>
            <div className={`${currTab==='inventory' ? '' : 'hidden'}`}><InventoryManager/></div>
            <div className={`${currTab==='editor' ? '' : 'hidden'}`}><ShowBuilder/></div>
            <div className={`${currTab==='receivers' ? '' : 'hidden'}`}><ReceiverDisplay setCurrentTab={setCurrTab}/></div>
            <div className={`${currTab==='loadout' ? '' : 'hidden'}`}><ShowLoadout setCurrentTab={setCurrTab}/></div>
            {currTab==='manual' ? (<ManualFiring/>) : ""}
            {currTab==='setting' ? (<SettingsPanel/>) : ""}
        </div>
        <div className="absolute bottom-0 left-0 w-full border-t border-gray-600 px-3 " style={{backgroundColor: "#000000aa"}}>
            <Status/>
        </div>
    </div>
  );
};
export default MainNav;